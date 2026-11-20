// Sets the saved theme before the first paint, so the page never flashes the other one.
try {
  const theme = localStorage.getItem("harnessd.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // No storage: the system theme applies.
}
