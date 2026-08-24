import type { AssignedTask, EpisodeSummary, ScanResult } from "../types";

export interface AssignedEpisodeSelection {
  episodes: EpisodeSummary[];
  taskByRoot: Record<string, string>;
}

export function assignedEpisodeSelection(
  episodes: EpisodeSummary[],
  assignments: AssignedTask[],
): AssignedEpisodeSelection {
  const sorted = [...episodes].sort((left, right) => left.root.localeCompare(right.root));
  const selected = new Map<string, EpisodeSummary>();
  const taskByRoot: Record<string, string> = {};
  for (const assignment of [...assignments]
    .filter((task) => task.status !== "paused")
    .sort((left, right) => left.order - right.order)) {
    const taskKey = assignment.task.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const matches = sorted.filter((episode) => {
      const pathKey = episode.root.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      return taskKey.length > 0 && pathKey.includes(taskKey);
    });
    for (const episode of matches.slice(assignment.startIndex, assignment.startIndex + assignment.quantity)) {
      if (selected.has(episode.root)) continue;
      selected.set(episode.root, episode);
      taskByRoot[episode.root] = assignment.task;
    }
  }
  return { episodes: [...selected.values()], taskByRoot };
}

export function assignmentFilterForSource(
  episodes: EpisodeSummary[],
  assignments: AssignedTask[],
  driveType: ScanResult["volume"]["driveType"],
): AssignedEpisodeSelection | null {
  if (!assignments.length || driveType === "removable") return null;
  return assignedEpisodeSelection(episodes, assignments);
}
