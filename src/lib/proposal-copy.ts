const KEEP_AS_IS = "or Discard to keep your story as it is.";

export function proposalConfirmation(changes: readonly string[] | undefined): string {
  const count = changes?.length ?? 0;
  if (count === 0) return `Ready to update your story. Apply to make this change, ${KEEP_AS_IS}`;
  if (count === 1) return `Ready to update your story: 1 change. Apply to make it, ${KEEP_AS_IS}`;
  return `Ready to update your story: ${count} changes. Apply to make them, ${KEEP_AS_IS}`;
}
