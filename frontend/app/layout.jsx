import "./globals.css";

export const metadata = {
  title: "GenTok",
  description: "YouTube → TikTok auto-clipping engine",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
