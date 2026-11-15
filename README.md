# WashDesk demo

A demo of the car wash management dashboard. It runs without a backend: every
request is answered in the browser by `utils/demo`, with sample data.

- Logins: `owner` / `demo1234` (Super Admin) and `staff` / `demo1234` (Admin).
- Changes are saved in the visitor's browser only. "Reset demo data" in the menu
  brings back the sample data.
- Uploaded files (photos, bills, screen ads) last until the page is reloaded.
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
