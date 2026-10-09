# Global decoder binding on a verified client upgrade

## Goal

Let Global production continue after an official client upgrade when the new
metadata merely moves the already verified bundle key and nonce seed to new
FieldRef positions. Keep unknown or rotated material outside automatic
publication.

## Inputs and trust boundary

The new APK must first pass the existing size, ETag, package identity, client
version, signer, and APK signature checks. Its decoded IL2CPP metadata must
pass the existing structural check. The previous decoder receipt, APK, metadata,
and exact external profile binding are read from restored private state; their
digests and signer are checked before using the previous material. Neither raw
key nor nonce seed is written to disk or logged.

## Binding flow

Try the exact external profile first. If absent, enumerate FieldRefs in the
new metadata that resolve uniquely to defaults owned by
`<PrivateImplementationDetails>`. Select a key FieldRef only if exactly one
contains the previously verified 16-byte key, and a distinct seed FieldRef
only if exactly one contains the previously verified 8-byte seed. Verify the
derived pair against three distinct encrypted bundles packaged in the new APK.
Each must decrypt to a valid UnityFS header with the bundle filename used by
the normal decoder. Then bind the derived row to the exact client version and
metadata SHA-256. Keep that row in the private decoder receipt and pass it to
the current-resource decoder for the same run and subsequent restored runs.
The external profile remains unchanged.

If no trusted prior receipt exists, any comparison is ambiguous, packaged
samples are insufficient, or any sample fails, stop before content production.
A client that rotates either material therefore needs a reviewed profile. The
ordinary content extraction and production checks remain mandatory before any
public pointer change.

## Verification

Unit tests cover unique relocation, ambiguous matches, changed material,
invalid prior receipt, insufficient samples, and invalid bundle headers. A
local read-only check against the official 1.0.3 APK must find one key and one
seed location and decrypt three packaged bundle headers. CI runs the new tests
with the existing Global suite. A production shadow run is required before
promotion.
