# Amex Native Offer Clicker

Tampermonkey userscript for adding Amex Offers by clicking the native Amex UI.

## Why this script exists

The direct enrollment API can hit CORS or 429 errors. The safer approach is to click the same native Amex offer buttons a person would click.

Important lessons from testing:

- Use each card's `opaqueAccountId`, not the stale card state currently shown in the page.
- After a card appears done, reload the same Offers URL and check again.
- Amex can lazy-load more offers after refresh.
- Skip checking accounts. Only process credit cards.
- A slower delay is safer. `5000ms` is a good default; `7000ms` is better after rate-limit errors.
- Amex can time out during long runs. Keep-alive is enabled by default and sends light page activity every few minutes.
- The floating panel uses low-frequency cached status updates so it does not keep scanning the whole Amex page.

## Usage

1. Install `AmexNativeOfferClicker.user.js` in Tampermonkey.
2. Open any `global.americanexpress.com` dashboard or offers page.
3. Use the floating `Amex Native Offers` panel.
4. Click `Scan Cards` to confirm detected cards.
5. Click `Add All Cards` to process all detected credit cards.
6. Leave `Keep Alive On` enabled for long runs. The default interval is `4` minutes.

The script runs card by card:

1. Open `/offers?opaqueAccountId=...`
2. Click visible native `+` buttons slowly.
3. Reload the same page.
4. Continue if more offers appear.
5. Move to the next card only after a refresh shows no more add buttons.

## Keep-alive

The panel includes a `Keep Alive On/Off` button and an interval input in minutes.

When enabled, the script periodically sends light activity to the page. If Amex shows a session prompt such as `Stay logged in` or `Continue session`, the script clicks it.

## Notes

This script does not make purchases or payments. It only adds available Amex Offers to cards through the visible Amex UI.
