#!/usr/bin/env node
// tp-browserd is the same daemon as ego-browserd (one code path; the old fork drifted and
// missed the vault restore and FIX-1151022 port handling). Kept as an entry-point alias.
import './ego-browserd.js';
