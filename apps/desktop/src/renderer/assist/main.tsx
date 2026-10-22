import { createRoot } from "react-dom/client";
import "../common/theme.css";
import "./assist.css";
import { App } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
