import { isEnabled, setEnabled } from "./settings.ts";

async function main(): Promise<void> {
  const checkbox = document.getElementById("enabled") as HTMLInputElement | null;
  if (!checkbox) return;
  checkbox.checked = await isEnabled();
  checkbox.addEventListener("change", () => {
    setEnabled(checkbox.checked).catch((err) => console.error("[flowgo] failed to save setting:", err));
  });
}

main().catch((err) => console.error("[flowgo] popup init failed:", err));
