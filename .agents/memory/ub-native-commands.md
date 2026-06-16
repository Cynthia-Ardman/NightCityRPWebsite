---
name: UB native commands uncontrollable
description: Why double work-pay can't be fixed in code
---
**Rule:** the website "Work" button (POST /economy/income/work, 20h cooldown in income_command_uses) and Discord `!work`/`!slut` are SEPARATE earning paths. The Discord ones are UnbelievaBoat-native commands.

**Why:** UnbelievaBoat exposes no API to read/set its native command cooldowns or config, so the website cannot detect or dedupe a UB `!work` use. A player can claim both per cooldown window = double pay.

**How to apply:** the only fix is disabling UB's native `!work`/`!slut` in the UnbelievaBoat dashboard so all income flows through the website's cooldowned endpoint. Communicate this to the operator — do not attempt a code-side dedupe.
