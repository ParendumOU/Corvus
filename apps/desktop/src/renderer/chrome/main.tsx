import { createRoot } from "react-dom/client";
import "../common/theme.css";
import "./chrome.css";
import "./command-bar.css";
import { App } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
