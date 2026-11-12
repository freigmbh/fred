import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { RouterProvider } from "@tanstack/react-router";
import "./index.css";
import { router } from "./router";

// Production is served by nginx on the same origin that proxies /api to Convex. Development points at the local instance.
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL ?? window.location.origin);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <RouterProvider router={router} />
    </ConvexProvider>
  </StrictMode>,
);
