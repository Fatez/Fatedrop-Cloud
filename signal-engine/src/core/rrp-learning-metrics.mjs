export function summariseRrpLearning(rows = []) {
  const summary = { total: rows.length, open: 0, candidate: 0, resolved: 0, genuineUnknown: 0, conflict: 0 };
  for (const row of rows) {
    if (row?.status === "open") summary.open += 1;
    else if (row?.status === "candidate") summary.candidate += 1;
    else if (row?.status === "resolved") summary.resolved += 1;
    else if (row?.status === "genuine_unknown") summary.genuineUnknown += 1;
    else if (row?.status === "conflict") summary.conflict += 1;
  }
  return summary;
}
