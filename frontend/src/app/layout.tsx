import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MafiaKvartalski - Telegram Web App",
  description: "Реалтайм ролевая игра Мафия с голосовым чатом для Telegram Web App",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head>
        {/* Load Telegram Web App Script */}
        <script src="https://telegram.org/js/telegram-web-app.js" defer></script>
        {/* Preconnect and Load Premium Font */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Inter:wght@300;400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
