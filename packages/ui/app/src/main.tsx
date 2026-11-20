import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import "./index.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider delay={400}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TooltipProvider>
    </StrictMode>,
  );
}
