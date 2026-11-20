// Sets the theme class before the first paint, so the page never flashes the other theme.
// "light" or "dark" is the saved choice; no saved choice follows the system.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("harnessd.theme");
  } catch {
    // No storage: the system theme applies.
  }
  const dark =
    saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
