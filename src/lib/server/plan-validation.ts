import type { ShotPlan } from "@/lib/story-planning";

export function findPlanProblem(plan: ShotPlan): string | null {
  if (!plan.scenes.length) return "The plan has no scenes.";
  for (const [sceneIndex, scene] of plan.scenes.entries()) {
    if (!scene.shots.length) return `Scene ${sceneIndex + 1} has no shots.`;
    for (const [shotIndex, shot] of scene.shots.entries()) {
      const where = `Scene ${sceneIndex + 1}, shot ${shotIndex + 1}`;
      if (!Number.isFinite(shot.seconds) || shot.seconds <= 0) return `${where} has an invalid duration.`;
      if (shot.dialogue.some(({ speaker, line }) => !speaker.trim() || !line.trim())) {
        return `${where} has an empty dialogue entry.`;
      }
    }
  }
  return null;
}
