#!/usr/bin/env node

import { setupCredentials as setupMoodle } from "./lib/moodle.mjs";
import { refreshCookie as refreshLevnet } from "./lib/levnet/levnet.mjs";

const moodle = await setupMoodle();
const levnet = await refreshLevnet({ prompt: false });
console.log(JSON.stringify({ moodle, levnet }, null, 2));
