import type { WorkerEnv } from "../env";
import { getRegistrationCatalog } from "./registration-catalog";
import { getPublicCenterInformation } from "../staff/public-content";
import { getPublicSiteFont } from "../staff/public-site-font";

const stageLabels = { stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" } as const;
type StageCode = keyof typeof stageLabels;
interface FamilyRow { stageCode: StageCode; title: string; recommendedGradeMin: string | null; recommendedGradeMax: string | null; shortDescription: string | null; longDescription: string | null; lessonCount: number; }

function durationMinutes(start: string, end: string): number | null {
  const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number);
  const minutes = eh * 60 + em - sh * 60 - sm; return minutes > 0 ? minutes : null;
}
export function publicProgramSlug(stage: StageCode): string { return ({ stage_1: "stage-1", stage_2: "stage-2", stage_3: "stage-3" })[stage]; }

export async function getPublicSiteModel(env: WorkerEnv) {
  const [center, catalog, families, font] = await Promise.all([
    getPublicCenterInformation(env), getRegistrationCatalog(env.DB, env.APP_ENV),
    env.DB.prepare(`SELECT family.annual_stage_code AS stageCode, family.display_name AS title,
      family.recommended_grade_min AS recommendedGradeMin, family.recommended_grade_max AS recommendedGradeMax,
      family.public_short_description AS shortDescription, family.public_long_description AS longDescription,
      COUNT(lesson.id) AS lessonCount
      FROM curriculum_program_family AS family
      LEFT JOIN curriculum_program AS program ON program.id = family.current_published_program_id
      LEFT JOIN curriculum_lesson AS lesson ON lesson.curriculum_program_id = program.id AND lesson.status = 'active'
      WHERE family.kind = 'annual_course' AND family.status = 'active'
      GROUP BY family.id ORDER BY family.annual_stage_code`).all<FamilyRow>(),
    getPublicSiteFont(env),
  ]);
  const sessions = catalog.academicYears.flatMap((year) => year.classSessions);
  const visibleStages = new Set(sessions.filter((session) => session.availability === "available" || session.availability === "full").map((session) => session.stageCode as StageCode));
  const programs = families.results.map((family) => {
    const stageSessions = sessions.filter((session) => session.stageCode === family.stageCode && (session.availability === "available" || session.availability === "full"));
    const duration = stageSessions.map((session) => durationMinutes(session.startTime, session.endTime)).find((value) => value != null) ?? null;
    return { ...family, slug: publicProgramSlug(family.stageCode), current: visibleStages.has(family.stageCode),
      registerHref: `/register/?stage=${family.stageCode}`, durationMinutes: duration,
      classSummary: stageSessions.map((session) => ({ label: session.label, availability: session.availability, remainingSeats: session.remainingSeats })),
    };
  });
  return { center, publicSiteFont: font.font, programs, currentPrograms: programs.filter((program) => program.current) };
}
