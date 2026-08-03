#!/usr/bin/env node

import { sessionStatus as moodleStatus } from "./lib/moodle.mjs";
import { endpointInventory, sessionStatus as levnetStatus } from "./lib/levnet/levnet.mjs";

const [moodle, levnet, inventory] = await Promise.all([
  moodleStatus({ promptIfExpired: false }),
  levnetStatus({ promptIfExpired: false }),
  endpointInventory(),
]);
console.log(JSON.stringify({ node: process.version, moodle, levnet, inventory }, null, 2));
