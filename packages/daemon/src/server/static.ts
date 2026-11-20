// Serves the built UI (D-020). Each file is an exact GET route, read once at start, so
// nothing outside the build folder is ever reachable.
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { RawBody, type Route } from "./router.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The page loads only its own files and talks only to this daemon. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    // Only plain files and folders: a link could point outside the build.
    entries.map((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
    ),
  );
  return files.flat();
}

/** GET routes for every file under `dir`, plus `/` for index.html. A missing folder gives none. */
export async function staticRoutes(dir: string): Promise<Route[]> {
  let files: string[];
  try {
    files = await walk(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const routes: Route[] = [];
  for (const file of files.sort()) {
    const path = `/${relative(dir, file).split(sep).join("/")}`;
    const type = TYPES[extname(file).toLowerCase()];
    if (type === undefined) continue;
    const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
    if (path.startsWith("/assets/")) {
      // Vite puts a content hash in every asset name.
      headers["cache-control"] = "public, max-age=31536000, immutable";
    } else {
      headers["cache-control"] = "no-cache";
    }
    if (type.startsWith("text/html")) {
      headers["content-security-policy"] = UI_CSP;
      headers["referrer-policy"] = "no-referrer";
    }
    const body = new RawBody(type, await readFile(file), headers);
    const route: Route = { method: "GET", path, handler: () => body };
    routes.push(route);
    if (path === "/index.html") routes.push({ ...route, path: "/" });
  }
  return routes;
}
