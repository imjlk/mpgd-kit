Original prompt: Add the small mpgd-kit gameplay/UI runtime fixture from PR3 of the attached five-PR plan, then extend it with fake monetization in PR5. No actual game migration or live monetization.

In progress: gameplay scene and independent UI scene, explicit initial inactive lifecycle, owned scene controls. Use bundled develop-web-game client and inspect screenshots, plus deterministic browser assertions.

Validated: 49 headless runtime tests, 20 fake Phaser binding tests, real Chromium scenarios and inspected settings/background/foreground screenshots. Added CREATE startup handling, exception-isolated cleanup, external pause/resume observation, and resume-last restoration for synchronous restarts. Full app teardown now terminates runtime before block cleanup and flushes Phaser deferred destruction in manual-step mode.

PR 5 extends the fixture with existing GameServicesClient plus deferred fake gateway/backend operations. Browser coverage includes duplicate calls, settings/ad overlap, purchase background/foreground, scope A close/new scope B before server settlement, owner completion, pending no-repurchase, rejected and exception paths. No real service calls.
