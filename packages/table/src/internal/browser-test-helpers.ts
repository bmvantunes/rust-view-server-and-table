export async function settleBrunoTableBrowserFrames(
  count = 2,
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => requestFrame(() => resolve()));
  }
}
