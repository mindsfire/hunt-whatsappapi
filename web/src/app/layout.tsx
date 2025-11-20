export const metadata = { title: 'Checkout' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap"
        />
      </head>
      <body style={{ fontFamily: 'Inter, system-ui, Arial, sans-serif', background: '#0b0b0c', color: '#eaeaea', margin: 0 }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
          {children}
        </div>
      </body>
    </html>
  );
}
