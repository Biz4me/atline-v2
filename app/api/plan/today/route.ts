import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { db } from '@/lib/db'
import { moduleTermine } from '@/lib/lms'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Moteur de priorité : cascade (5 niveaux) + score + équilibre ──
// Niveaux : 1 Temporel · 2 Momentum · 3 Valeur · 4 Discipline · 5 Investissement

type Cand = {
  contactId: string
  name: string
  prenom: string
  initials: string
  accent: string
  level: number
  priority: number
  action: string
  headline: string
  reason: string
  channel: string | null
  stage: string
  phone: string | null
  email: string | null
  market: string | null
  route: string | null // socle : surface à ouvrir (fondation) ; null pour une action par contact
  apptId?: string | null // RDV concerné (actions DEBRIEF / RDV) — pour solder le bon rendez-vous
}

// score_opportunité (aligné sur computeScore de /api/contacts/[id])
function opportunity(c: { kind: string; prospectStage: string | null; partnerStage: string | null; market: string | null; lastContact: Date | null }): number {
  let base = 15
  if (c.kind === 'PARTENAIRE') base = ({ DEMARRAGE: 55, FORMATION: 70, ACTIF: 85, LEADER: 95 } as Record<string, number>)[c.partnerStage ?? ''] ?? 55
  else if (c.kind === 'CLIENT') base = 55
  else base = ({ NOUVEAU: 15, INVITATION: 30, PRESENTATION: 50, SUIVI: 65, CLOSING: 80 } as Record<string, number>)[c.prospectStage ?? ''] ?? 15
  let fresh = 0
  if (c.lastContact) {
    const days = (Date.now() - new Date(c.lastContact).getTime()) / 86_400_000
    fresh = days < 7 ? 0 : days < 14 ? -5 : days < 30 ? -15 : -25
  }
  const temp = c.market === 'CHAUD' ? 5 : c.market === 'FROID' ? -5 : 0
  return Math.max(0, Math.min(100, Math.round(base + fresh + temp)))
}

// potentiel_partenaire : nb de signaux renseignés (motivation/insatisfaction/réseau/ouverture)
function potentielMult(q: unknown): number {
  const obj = (q && typeof q === 'object' && !Array.isArray(q)) ? (q as Record<string, unknown>) : {}
  const n = ['motivation', 'insatisfaction', 'reseau', 'ouverture'].filter((k) => typeof obj[k] === 'string' && (obj[k] as string).trim()).length
  return n >= 3 ? 1.5 : n === 2 ? 1.2 : 1.0
}

async function activeBusinessId(userId: string): Promise<string | null> {
  const prefs = await db.userPreferences.findUnique({ where: { userId }, select: { activeCompanyId: true } })
  if (prefs?.activeCompanyId) {
    const b = await db.userMlmBusiness.findFirst({ where: { id: prefs.activeCompanyId, userId }, select: { id: true } })
    if (b) return b.id
  }
  const first = await db.userMlmBusiness.findFirst({ where: { userId }, orderBy: { position: 'asc' }, select: { id: true } })
  return first?.id ?? null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  const bizId = await activeBusinessId(userId)
  if (!bizId) return NextResponse.json({ items: [] })

  const now = Date.now()
  const [contacts, appts, relances, recentInteractions] = await Promise.all([
    db.contact.findMany({
      where: { userId, mlmBusinessId: bizId },
      select: {
        id: true, name: true, firstName: true, initials: true, accent: true, kind: true,
        prospectStage: true, partnerStage: true, market: true, exposures: true,
        lastContact: true, birthDate: true, phone: true, email: true, qualification: true, lastDraft: true,
      },
    }),
    db.appointment.findMany({ where: { userId, done: false }, select: { id: true, contactId: true, title: true, startAt: true } }),
    db.relance.findMany({ where: { userId, status: 'PENDING', dueAt: { lte: new Date() } }, select: { id: true, contactId: true, channel: true } }).catch(() => []),
    db.interaction.findMany({
      where: { userId, outcome: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { contactId: true, outcome: true },
    }).catch(() => []),
  ])

  // Modulation par l'outcome (spec catalogue) : dernier échange POSITIF ↑, SANS_REPONSE répété ↓.
  const lastOutcomes = new Map<string, string[]>()
  for (const i of recentInteractions) {
    const arr = lastOutcomes.get(i.contactId) ?? []
    if (arr.length < 2) { arr.push(i.outcome as string); lastOutcomes.set(i.contactId, arr) }
  }
  const outcomeMult = (contactId: string): number => {
    const o = lastOutcomes.get(contactId) ?? []
    if (o[0] === 'POSITIF') return 1.3
    if (o[0] === 'SANS_REPONSE' && o[1] === 'SANS_REPONSE') return 0.7
    return 1.0
  }

  const byId = new Map(contacts.map((c) => [c.id, c]))
  const prenom = (c: { firstName: string | null; name: string }) => c.firstName || c.name.split(' ')[0]
  const initialsOf = (c: { initials: string | null; name: string }) => c.initials ?? c.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  const cands: Cand[] = []
  const seen = new Set<string>() // 1 candidat max par contact (le 1er = le plus prioritaire)

  const push = (c: typeof contacts[number], level: number, action: string, headline: string, reason: string, channel: string | null, apptId: string | null = null) => {
    cands.push({
      contactId: c.id, name: c.name, prenom: prenom(c), initials: initialsOf(c), accent: c.accent ?? '#F97316',
      level, priority: Math.round(opportunity(c) * potentielMult(c.qualification) * outcomeMult(c.id)),
      action, headline, reason, channel, stage: c.prospectStage ?? c.partnerStage ?? '',
      phone: c.phone, email: c.email, market: c.market, route: null, apptId,
    })
  }

  // ── Niveau 1.5 — GATE de phase : la Fondation (Bande A) prime tant qu'elle n'est pas posée ──
  // Séquence : Rencontre (mon histoire avec l'activité) → M1 Mindset → M2 Pourquoi → M4 Liste.
  // On ne pousse au tunnel (niv. 2+) qu'une fois ces prérequis posés. Les incontournables temporels (niv. 1) passent toujours avant.
  const [user, business, mindsetModule] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { coaching: true } }),
    db.userMlmBusiness.findUnique({ where: { id: bizId }, select: { story: true, objectif: true } }),
    db.lmsModule.findFirst({ where: { position: 0 }, select: { id: true } }).catch(() => null),
  ])
  // Un module est terminé quand ses leçons sont faites ET ses quiz réussis — deux
  // tables distinctes. La règle vit dans lib/lms.ts pour n'exister qu'une fois.
  let mindsetDone = false
  if (mindsetModule) {
    const lecons = await db.lmsLesson.findMany({
      where: { moduleId: mindsetModule.id }, select: { id: true, kind: true },
    }).catch(() => [] as { id: string; kind: string }[])
    if (lecons.length) {
      const ids = lecons.map((l) => l.id)
      const [faites, reussis] = await Promise.all([
        db.userLessonProgress.findMany({
          where: { userId, lessonId: { in: ids }, done: true }, select: { lessonId: true },
        }).catch(() => []),
        db.userQuizAttempt.findMany({
          where: { userId, lessonId: { in: ids }, passed: true }, select: { lessonId: true },
        }).catch(() => []),
      ])
      mindsetDone = moduleTermine(
        lecons,
        new Set(faites.map((p) => p.lessonId)),
        new Set(reussis.map((a) => a.lessonId)),
      )
    }
  }
  const coaching = (user?.coaching && typeof user.coaching === 'object' && !Array.isArray(user.coaching)) ? (user.coaching as Record<string, unknown>) : {}
  const hasStory = typeof business?.story === 'string' && business.story.trim().length > 0
  const hasMindset = (typeof coaching.mindset === 'string' && (coaching.mindset as string).trim().length > 0) || mindsetDone
  const hasWhy = typeof coaching.why === 'string' && (coaching.why as string).trim().length > 0
  const objectif = (business?.objectif && typeof business.objectif === 'object' && !Array.isArray(business.objectif)) ? (business.objectif as Record<string, unknown>) : {}
  const hasObjectif = typeof objectif.mensuel === 'string' && (objectif.mensuel as string).trim().length > 0
  const listCount = contacts.length
  // Aiguillage débutant/établi (posé à l'onboarding) : un établi commence par un AUDIT, pas par « construis ta liste ».
  const isEstabli = coaching.experience === 'etabli'
  const hasDiagnostic = typeof coaching.diagnostic === 'string' && (coaching.diagnostic as string).trim().length > 0

  const foundItem = (action: string, rank: number, headline: string, reason: string, route: string | null): Cand => ({
    contactId: '', name: '', prenom: '', initials: '', accent: '#F97316',
    level: 1.5, priority: 100 + rank, action, headline, reason, channel: null, stage: 'SOCLE',
    phone: null, email: null, market: null, route,
  })
  // Établi sans diagnostic : l'audit prime sur tout le reste de la fondation (rang le plus haut).
  if (isEstabli && !hasDiagnostic) cands.push(foundItem('FOUND_DIAGNOSTIC', 5, 'Faisons ton diagnostic complet', 'Tu as déjà de la bouteille — 10 min pour un audit honnête de ton activité : tes forces, tes failles, et LA priorité de ta semaine. On part de là.', null))
  // Le bon départ (dans l'ordre) : brise-glace (rencontre) → posture (mindset) → profondeur (pourquoi) → matière (liste).
  if (!hasStory)               cands.push(foundItem('FOUND_RENCONTRE', 4, 'Raconte-moi ta rencontre avec ton activité', 'Ton histoire avec ce business : comment tu l’as découvert et pourquoi tu y crois. C’est mon point de départ pour te coacher juste.', null))
  // Mindset : session « établir & vérifier » (posé si session faite OU module M1 terminé).
  if (!hasMindset)             cands.push(foundItem('FOUND_MINDSET', 3, 'Pose ton état d’esprit de pro', 'La posture d’un pro : un vrai métier, pas un jackpot ; la régularité bat le talent. 5 min avec moi et tu pars sur les bons rails.', null))
  if (!hasWhy)                cands.push(foundItem('FOUND_WHY', 2, 'Formule ton pourquoi', 'Module 2 — ton moteur. Sans un pourquoi clair, tout s’essouffle. On le travaille ensemble.', null))
  if (listCount < 10)         cands.push(foundItem('FOUND_LIST', 1, 'Construis ta liste de noms', `Module 4 — la matière première de ton activité. Tu as ${listCount} contact${listCount > 1 ? 's' : ''}, vise 100 noms.`, '/contacts'))
  // Objectifs : APRÈS la liste (rang le plus bas) — pour fixer des cibles réalistes, pas dans le vide.
  else if (!hasObjectif)      cands.push(foundItem('FOUND_OBJECTIFS', 0, 'Fixe tes objectifs de partenaires', 'Maintenant que ta liste tourne, on pose de vrais objectifs mesurables — un cap mensuel et ta trajectoire à 3, 6, 12 mois.', null))

  // ── ÉLAN D'ONBOARDING : le 1er message est PRÊT → « envoie-le » passe AVANT le socle ──
  // On a promis cette action à la fin de l'onboarding. Un nouveau qui agit une fois dans les 5 min reste ;
  // lui demander de « raconter sa rencontre » avant d'avoir envoyé un seul message, c'est le perdre.
  // priority 110 > tout le socle (max 105) → n°1 ; se dissout dès qu'il a écrit (lastContact posé).
  for (const c of contacts) {
    if (c.kind !== 'PROSPECT' || c.prospectStage !== 'NOUVEAU' || c.lastContact) continue
    if (typeof c.lastDraft !== 'string' || !c.lastDraft.trim()) continue
    cands.push({
      contactId: c.id, name: c.name, prenom: prenom(c), initials: initialsOf(c), accent: c.accent ?? '#F97316',
      level: 1.5, priority: 110, action: 'MESSAGE',
      headline: `Envoie ton premier message à ${prenom(c)}`,
      reason: `Ton message est prêt — un tap, tu l'ajustes si tu veux, et tu lances ta toute première conversation.`,
      channel: c.phone ? 'WHATSAPP' : c.email ? 'EMAIL' : null,
      stage: c.prospectStage ?? '', phone: c.phone, email: c.email, market: c.market, route: null,
    })
  }

  // ── Niveau 1 — Temporel (fenêtres qui se ferment) ──
  const today = new Date()
  for (const c of contacts) {
    if (!c.birthDate) continue
    const b = new Date(c.birthDate)
    if (b.getMonth() === today.getMonth() && b.getDate() === today.getDate()) {
      push(c, 1, 'MESSAGE', `Souhaite l'anniversaire de ${prenom(c)} 🎂`, `C'est son anniversaire aujourd'hui — un mot fait toute la différence.`, c.phone ? 'WHATSAPP' : c.email ? 'EMAIL' : null)
    }
  }
  for (const a of appts) {
    if (!a.contactId) continue
    const c = byId.get(a.contactId); if (!c) continue
    const t = new Date(a.startAt).getTime()
    // Partenaire = la signature est actée (annoncée en chat ou au débrief) : on ne redemande JAMAIS l'issue.
    if (t < now) { if (c.kind !== 'PARTENAIRE') push(c, 1, 'DEBRIEF', `Débriefe ton RDV avec ${prenom(c)}`, `RDV passé non débriefé — saisis le résultat pour débloquer la suite.`, null, a.id) }
    else if (t - now < 2 * 86_400_000) push(c, 1, 'RDV', `Prépare ton RDV avec ${prenom(c)}`, `RDV « ${a.title} » à venir — prépare-le et confirme.`, null, a.id)
  }
  for (const r of relances) {
    const c = byId.get(r.contactId); if (!c) continue
    // Garde-fou : une relance de PROSPECTION ne survit pas à la signature (données anciennes).
    if (c.kind === 'PARTENAIRE') continue
    push(c, 1, 'MESSAGE', `Relance ${prenom(c)}`, `Relance programmée arrivée à échéance.`, (r.channel || '').toUpperCase() || (c.phone ? 'WHATSAPP' : c.email ? 'EMAIL' : null))
  }

  // ── Niveaux 2-4 — un pas par contact selon le flow ──
  for (const c of contacts) {
    const days = c.lastContact ? Math.floor((now - new Date(c.lastContact).getTime()) / 86_400_000) : null
    const stale = days !== null && days >= 5
    const channel = c.phone ? 'WHATSAPP' : c.email ? 'EMAIL' : null
    if (c.kind === 'PARTENAIRE') {
      if (c.partnerStage === 'DEMARRAGE') push(c, 2, 'MESSAGE', `Accompagne le démarrage de ${prenom(c)}`, `Nouveau partenaire — cadre ses 48h et ses premières actions.`, channel)
      else push(c, 4, 'MESSAGE', `Soutiens ${prenom(c)}`, `Reste présent, valorise sa progression (Go Pro · Skill 6).`, channel)
      continue
    }
    if (c.kind === 'CLIENT') { push(c, 4, 'MESSAGE', `Prends des nouvelles de ${prenom(c)}`, stale ? `Client sans contact depuis ${days}j — relance / propose l'opportunité.` : `Fidélise ou propose l'opportunité (upsell).`, channel); continue }
    // PROSPECT
    switch (c.prospectStage) {
      case 'CLOSING':
        push(c, 2, 'MESSAGE', `Close ${prenom(c)}`, `En phase de décision — propose-lui de démarrer maintenant.`, channel); break
      case 'SUIVI':
        if (c.exposures >= 4) push(c, 2, 'MESSAGE', `Tente le closing avec ${prenom(c)}`, `${c.exposures} expositions — c'est le moment de proposer de décider.`, channel)
        else push(c, 4, 'MESSAGE', `Continue le suivi de ${prenom(c)}`, `${c.exposures} exposition${c.exposures > 1 ? 's' : ''} — encore un contact ou deux avant de closer.`, channel)
        break
      case 'PRESENTATION':
        push(c, 4, 'MESSAGE', `Fais le suivi de ${prenom(c)}`, `« La fortune est dans le suivi » — reviens vers lui/elle.`, channel); break
      case 'INVITATION':
        // Non relancé = le moment de PRÉSENTER (format « présenter = support » : le flux chat propose de joindre un support).
        if (stale) push(c, 4, 'MESSAGE', `Relance ton invitation à ${prenom(c)}`, `Invité il y a ${days}j sans suite.`, channel)
        else push(c, 3, 'PRESENTER', `Propose une présentation à ${prenom(c)}`, `A réagi — propose d'en voir plus, support à l'appui.`, channel)
        break
      default: // NOUVEAU
        push(c, 3, 'MESSAGE', `Invite ${prenom(c)}`, `Nouveau dans ta liste — lance la conversation et crée la curiosité.`, channel)
    }
  }

  // ── Niveau 5 — Investissement (soi) : formation en cours, lecture — remplit le plan quand le terrain est calme ──
  const selfItem = (action: string, rank: number, headline: string, reason: string, route: string): Cand => ({
    contactId: '', name: '', prenom: '', initials: '', accent: '#F97316',
    level: 5, priority: rank, action, headline, reason, channel: null, stage: 'PERSO',
    phone: null, email: null, market: null, route,
  })
  try {
    const [allLessons, doneProgress] = await Promise.all([
      db.lmsLesson.findMany({
        where: { published: true },
        orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
        select: { id: true, moduleId: true, module: { select: { title: true } } },
      }),
      db.userLessonProgress.findMany({ where: { userId, done: true }, select: { lessonId: true } }),
    ])
    const doneIds = new Set(doneProgress.map((p) => p.lessonId))
    const nextLesson = allLessons.find((l) => !doneIds.has(l.id))
    if (nextLesson) cands.push(selfItem('FORMATION', 2, `Continue ta formation : ${nextLesson.module.title}`, 'Un pas de formation par jour — la discipline qui paie sur 90 jours.', `/formation/${nextLesson.moduleId}`))
    const [reads, books] = await Promise.all([
      db.userBookInteraction.findMany({ where: { userId, read: true }, select: { bookId: true } }),
      db.mlmBook.findMany({ where: { priority: 'ESSENTIEL', dispoFR: true }, orderBy: { rang: 'asc' }, select: { id: true, titreFR: true, auteur: true } }),
    ])
    const readIds = new Set(reads.map((r) => r.bookId))
    const book = books.find((b) => !readIds.has(b.id))
    if (book) cands.push(selfItem('LECTURE', 1, `Avance dans « ${book.titreFR} »`, `${book.auteur} — les leaders sont des lecteurs. 10 pages aujourd'hui suffisent.`, '/formation/library'))
  } catch { /* investissement best-effort : le plan terrain reste complet sans */ }

  // ── Tri : niveau asc, puis priorité desc ; équilibre : 1 par contact, plafond 7 ──
  cands.sort((a, b) => a.level - b.level || b.priority - a.priority)
  const plan: Cand[] = []
  for (const c of cands) {
    const key = c.contactId || c.action // socle : pas de contact → clé = l'action (unique)
    if (seen.has(key)) continue
    seen.add(key)
    plan.push(c)
    if (plan.length >= 7) break
  }

  // Compteur d'objectif du mois : partenaires signés (signedAt) vs objectif.mensuel.
  // La boucle agenda → débrief → « signé » → partenaire rend enfin l'objectif MESURABLE.
  const objMensuel = parseInt(String(objectif.mensuel ?? ''), 10)
  const signedThisMonth = hasObjectif && Number.isFinite(objMensuel)
    ? await db.contact.count({
        where: {
          userId, mlmBusinessId: bizId, kind: 'PARTENAIRE',
          signedAt: { gte: new Date(today.getFullYear(), today.getMonth(), 1) },
        },
      })
    : 0

  return NextResponse.json({
    items: plan,
    total: cands.length,
    objectif: hasObjectif && Number.isFinite(objMensuel) ? { mensuel: objMensuel, signed: signedThisMonth } : null,
  })
}
