# WashDesk demo

A demo of the car wash management dashboard. It runs without a backend: every
request is answered in the browser by `utils/demo`, with sample data.

- Logins: `owner` / `demo1234` (Super Admin) and `staff` / `demo1234` (Admin).
- The sample data is small (about 5 rows per page) so it is easy to follow.
- Visitors can add, edit and delete anything. Changes are kept in the visitor's
  browser for 20 seconds after their last change, with a countdown at the bottom
  of the screen, then the sample data comes back and the page reloads. Change the
  time with `CHANGE_TTL_MS` in `utils/demo/core.js`. "Reset demo data" in the
  menu brings the sample data back at once.
- Uploaded files (photos, bills, screen ads) are cleared with the other changes,
  or when the page is reloaded.
- No WhatsApp message is really sent by the Broadcast page; it is simulated.

## Run

    npm install
    npm run dev

## Deploy to Vercel

Import the repository in Vercel. It is a standard Next.js app: no environment
variables are needed.

## Change the name or colours

- Name: search for "WashDesk" in `app` and `utils`.
- Colours: the variables at the top of `app/globals.css`.
- Logo: `public/washdesk-logo.png`, `public/washdesk-logo-dark.png`,
  `public/washdesk-emblem.png`, `app/icon.png`.
