// © Infinitum Corporation®. All rights reserved.

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./i18n/start.js";
import { initEideticAmplitude } from "@eidetic/analytics";

initEideticAmplitude("review-desk");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
