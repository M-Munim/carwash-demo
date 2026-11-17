'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { Loader2, AlertCircle, Phone, MessageCircle, X } from 'lucide-react';
import logo from '../../../public/washdesk-logo.png';
import { API_PATHS } from '../../../utils/apiPaths';
import { api } from '../../../utils/axiosInstance';
import { CHAT_LINK, CHAT_NUMBER_TEXT } from '../../../utils/broadcastText';

const day = (d) => (d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/**
 * The customer's inspection page (opened from the WhatsApp link): their car's
 * after-service photos and videos. The long random token in the URL is the key.
 */
export default function InspectionPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(null); // photo being viewed full screen

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(API_PATHS.JOB_CARDS.PUBLIC_INSPECTION(token));
        if (alive) setData(res.data.data);
      } catch (err) {
        if (alive) setError(err?.response?.status === 404 ? 'This link is not valid any more.' : 'Could not load the page. Please try again.');
      }
    })();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (!zoom) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // Demo: files come from the in-browser demo API as blobs (no server to link to)
  const [urls, setUrls] = useState({}); // media id → object URL or 'missing'
  useEffect(() => {
    if (!data) return undefined;
    let alive = true;
    const made = [];
    data.media.forEach(async (m) => {
      let value = 'missing';
      try {
        const res = await api.get(API_PATHS.JOB_CARDS.PUBLIC_INSPECTION_MEDIA(token, m.id), { responseType: 'blob' });
        value = URL.createObjectURL(res.data);
        made.push(value);
      } catch { /* uploaded in another tab: not in this tab's memory */ }
      if (alive) setUrls((prev) => ({ ...prev, [m.id]: value }));
    });
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [data, token]);
  const src = (m) => (urls[m.id] && urls[m.id] !== 'missing' ? urls[m.id] : undefined);
  const Missing = () => (
    <div className="w-full aspect-[4/3] flex items-center justify-center bg-gray-100 px-4 text-center text-xs text-gray-500">
      Demo: files you upload stay in the browser tab where you added them.
    </div>
  );
  const car = data ? [data.vehicle.make, data.vehicle.model, data.vehicle.year].filter(Boolean).join(' ') : '';

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-[#1f1f1f] border-b-4 border-[var(--primary)]">
        <div className="mx-auto max-w-4xl px-4 py-4 flex items-center justify-between gap-3">
          <Image src={logo} alt="WashDesk Car Wash and Auto Care" className="h-12 w-auto" priority />
          <span className="text-xs sm:text-sm font-semibold text-white/90 text-right">Car inspection</span>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6 space-y-5">
        {!data && !error && (
          <p className="py-16 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin inline" aria-hidden="true" /> Loading…</p>
        )}

        {error && (
          <div className="bg-white border border-gray-200 p-6 text-center space-y-2">
            <AlertCircle className="w-8 h-8 text-gray-400 mx-auto" aria-hidden="true" />
            <p className="text-gray-800">{error}</p>
            <p className="text-sm text-gray-500">Please contact WashDesk on <a href={CHAT_LINK} className="text-[var(--primary-dark)] underline" dir="ltr">{CHAT_NUMBER_TEXT}</a>.</p>
          </div>
        )}

        {data && (
          <>
            <section className="bg-white border border-gray-200 p-5">
              <h1 className="text-xl font-bold text-gray-900">
                {data.customer_name ? `Hi ${data.customer_name}, your` : 'Your'} car after the service
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {[car, data.vehicle.color, data.vehicle.plate && `Plate ${data.vehicle.plate}`].filter(Boolean).join(' · ')}
              </p>
              {data.services.length > 0 && <p className="mt-2 text-sm text-gray-800"><b>Service:</b> {data.services.join(', ')}</p>}
              <p className="mt-1 text-xs text-gray-500">Job card {data.job_number}{data.checked_at ? ` · Checked ${day(data.checked_at)}` : ''}</p>
            </section>

            {data.media.length === 0 ? (
              <p className="bg-white border border-gray-200 p-6 text-center text-gray-600">The photos are not ready yet. Please check again a little later.</p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {data.media.map((m) => (
                  <li key={m.id} className="bg-white border border-gray-200">
                    {!urls[m.id] ? (
                      <div className="w-full aspect-[4/3] flex items-center justify-center bg-gray-100"><Loader2 className="w-5 h-5 animate-spin text-gray-400" aria-hidden="true" /></div>
                    ) : urls[m.id] === 'missing' ? (
                      <Missing />
                    ) : m.kind === 'video' ? (
                      <video src={src(m)} controls playsInline preload="metadata" className="w-full aspect-video bg-black" />
                    ) : (
                      <button type="button" onClick={() => setZoom(m)} className="block w-full" aria-label={`View photo full screen${m.caption ? `: ${m.caption}` : ''}`}>
                        {/* Served by the API with the link's token; not a static asset next/image can optimise */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src(m)} alt={m.caption || 'Your car after the service'} loading="lazy" className="w-full aspect-[4/3] object-cover bg-gray-100" />
                      </button>
                    )}
                    {m.caption && <p className="px-3 py-2 text-sm text-gray-700">{m.caption}</p>}
                  </li>
                ))}
              </ul>
            )}

            <section className="bg-white border border-gray-200 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-sm text-gray-700">Questions about your car? We&apos;re happy to help.</p>
              <div className="flex gap-2">
                <a href={CHAT_LINK} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 text-white hover:bg-green-700">
                  <MessageCircle className="w-4 h-4" aria-hidden="true" /> WhatsApp us
                </a>
                <a href="tel:+97444000000" className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50">
                  <Phone className="w-4 h-4" aria-hidden="true" /> Call
                </a>
              </div>
            </section>
            <p className="text-center text-xs text-gray-400">WashDesk Car Wash &amp; Auto Care · Doha, Qatar · @washdesk.demo</p>
          </>
        )}
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-3" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setZoom(null)}>
          <button type="button" onClick={() => setZoom(null)} aria-label="Close" className="absolute top-3 right-3 p-2 text-white/80 hover:text-white">
            <X className="w-7 h-7" aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src(zoom)} alt={zoom.caption || 'Your car after the service'} className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </main>
  );
}
