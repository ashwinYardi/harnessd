// The harnessd web UI (MET-18). The React app in `app/` is built by Vite into `dist/app`,
// and the daemon serves that folder (D-024). This entry only says where it is.
import { fileURLToPath } from "node:url";

export const UI_PACKAGE = "@harnessd/ui";

/** The built app. It exists once `pnpm build` has run. */
export const UI_DIR = fileURLToPath(new URL("./app/", import.meta.url));
