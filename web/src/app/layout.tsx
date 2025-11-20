export const metadata = { title: 'Checkout' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'Inter, system-ui, Arial, sans-serif', background: '#0b0b0c', color: '#eaeaea', margin: 0 }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
          {children}
        </div>
      </body>
    </html>
  );
}
