# Live2D Cubism Core notice

`live2dcubismcore.min.js` is the official Live2D Cubism Core for Web runtime.
It is **not included in this public source repository**. Obtain it separately
from the [official SDK](https://www.live2d.com/en/sdk/download/web/) under the
applicable terms before providing it to a deployment.

The runtime remains Copyright Live2D Inc. and is governed by its embedded
notice and the [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).
Retain those notices with any permitted copy.

When provided, the site loads a local copy. If it is absent, the site falls back
to the official [Cubism Core for Web hosting endpoint](https://www.live2d.com/en/sdk/download/web/).
Set `OURNOTES_LIVE2D_CORE_FILE` to an authorized local copy when building a
private code release to include that copy without adding it to Git.
The separate `pixi-live2d-display` integration is
MIT-licensed; that license does not cover Cubism Core or game models.

See the repository's [licensing notes](../../../../docs/LICENSING.md) and
[third-party inventory](../../../../THIRD_PARTY_NOTICES.md).
