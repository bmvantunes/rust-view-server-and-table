/// <reference types="vite/client" />

import { createRoot } from "react-dom/client";
import { PackedApplication } from "./App";
import "./bruno-table.css";

createRoot(document.getElementById("root")!).render(<PackedApplication />);
