/**
 * La règle unique : quand un module de formation est-il terminé ?
 *
 * Un module n'est pas « toutes ses leçons lues ». Il contient deux natures de
 * contenu qui se valident dans deux tables différentes :
 *   - les leçons (kind LESSON)  →  UserLessonProgress.done
 *   - les quiz   (kind QUIZ)    →  UserQuizAttempt.passed
 *
 * Cette règle était écrite en clair dans app/api/formation/modules/route.ts.
 * Le plan du jour, lui, interrogeait UserLmsProgress — une table remplacée par
 * UserLessonProgress et jamais écrite depuis. Résultat : un distributeur qui
 * terminait le module Mindset n'était pas reconnu comme l'ayant fait, et le
 * plan du jour continuait de lui réclamer une étape déjà accomplie.
 *
 * On la sort ici pour qu'il n'y ait qu'une définition de « terminé ».
 */

export type LeconPourAvancement = { id: string; kind: string }

export type AvancementModule = {
  total: number
  faites: number
  pct: number
  status: 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED'
}

/**
 * Calcule l'avancement d'un module à partir de données déjà chargées.
 * Volontairement pure : l'appelant décide comment il va chercher les leçons,
 * les leçons faites et les quiz réussis.
 */
export function avancementModule(
  lecons: LeconPourAvancement[],
  leconsFaites: Set<string>,
  quizReussis: Set<string>,
): AvancementModule {
  const cours = lecons.filter((l) => l.kind === 'LESSON')
  const quiz = lecons.filter((l) => l.kind === 'QUIZ')

  const coursFaits = cours.filter((l) => leconsFaites.has(l.id)).length
  const quizPasses = quiz.filter((l) => quizReussis.has(l.id)).length

  const total = lecons.length
  const faites = coursFaits + quizPasses
  const pct = total ? Math.round((faites / total) * 100) : 0

  const tousLesCours = cours.every((l) => leconsFaites.has(l.id))
  const tousLesQuiz = quiz.length === 0 || quiz.every((l) => quizReussis.has(l.id))
  const status = tousLesCours && tousLesQuiz && total > 0
    ? 'DONE'
    : pct > 0
      ? 'IN_PROGRESS'
      : 'NOT_STARTED'

  return { total, faites, pct, status }
}

/** Raccourci : ce module est-il terminé ? */
export function moduleTermine(
  lecons: LeconPourAvancement[],
  leconsFaites: Set<string>,
  quizReussis: Set<string>,
): boolean {
  return avancementModule(lecons, leconsFaites, quizReussis).status === 'DONE'
}
