# Browser card import feasibility

Approved scope: a standalone browser prototype that accepts local screenshots, identifies catalog cards, reads visible growth, supports review and exports a draft. No production deployment or personal inventory writes. Static files only; all screenshot computation stays in dedicated browser workers. Existing Python result page remains available for comparison.

Use offline ORB descriptors keyed by region, source release, card ID and asset ID. OpenCV.js performs Hamming matching and geometric verification; Tesseract.js reads small numeric regions; lit badge sectors supply star/petal counts. Reject weak card matches and ambiguous values. Keep game observations separate from legacy storage field names. Merge only confirmed observations, report conflicts and never default missing skill levels.

First supported layout is the supplied landscape member list (6 columns) and support list (4 columns), normalized by width. The preview shows extracted card regions; unsupported aspect ratios stop and other layouts remain explicitly unverified. Bottom partial rows are excluded. Grid adaptation and current catalog coverage remain measurable limitations.

UI: pale lavender #f4f3fa canvas, white #ffffff panels, ink #292641, violet #6554b9 actions, teal #237a68 confirmation, amber #a66b18 review. System rounded sans headings, system sans body, monospace timings. Main signature: screenshot crop and catalog art side by side, with visible growth controls. Desktop review grid becomes a single column on phones. Accessible labels, keyboard focus, no decorative animation.

Validation: supplied screenshots through real browser upload/sample flow; compare IDs/observations to manual transcription; cancellation and re-run; ambiguous/missing fields; core merge tests; first-load resource sizes and per-image browser timing. These are calibration samples, not held-out accuracy or physical-phone acceptance.
