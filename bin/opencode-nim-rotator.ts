#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { initApp } from "../dist/tui/app.js";
import { state } from "../dist/tui/state.js";

const renderer = await createCliRenderer({ exitOnCtrlC: false });

state.renderer = renderer;
initApp();
