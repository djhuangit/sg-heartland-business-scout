
import React from 'react';

export const HDB_TOWNS = [
  'Ang Mo Kio', 'Bedok', 'Bishan', 'Bukit Batok', 'Bukit Merah', 
  'Bukit Panjang', 'Bukit Timah', 'Central Area', 'Choa Chu Kang', 
  'Clementi', 'Geylang', 'Hougang', 'Jurong East', 'Jurong West', 
  'Kallang/Whampoa', 'Lim Chu Kang', 'Marine Parade', 'Pasir Ris', 
  'Punggol', 'Queenstown', 'Sembawang', 'Sengkang', 'Serangoon', 
  'Tampines', 'Toa Payoh', 'Woodlands', 'Yishun'
];

export const BUSINESS_TYPES = [
  'Bubble Tea Shop', 'GP Clinic', 'Bakery', 'Enrichment Centre', 
  'Cafe', 'Minimart', 'Optical Shop', 'Laundromat', 'Hardware Store'
];

export const Icons = {
  Search: (props: React.SVGProps<SVGSVGElement>) => (
    <svg fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  ),
  Map: (props: React.SVGProps<SVGSVGElement>) => (
    <svg fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-10.5v.75m.001 3v.75m0 3v.75m0 3v.75M12 12.75h.001m-3.001 0h.001m3.001-3h.001m-3.001 0h.001m3.001-3h.001m-3.001 0h.001M12 21l-4.217-1.406a1.981 1.981 0 0 0-1.283 0L2.25 21V5.25c0-.98.667-1.75 1.5-1.75h16.5c.833 0 1.5.77 1.5 1.75V21l-4.217-1.406a1.981 1.981 0 0 0-1.283 0L12 21Z" />
    </svg>
  ),
  TrendUp: (props: React.SVGProps<SVGSVGElement>) => (
    <svg fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18 9 11.25l4.306 4.307a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941" />
    </svg>
  ),
  Alert: (props: React.SVGProps<SVGSVGElement>) => (
    <svg fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  )
};
