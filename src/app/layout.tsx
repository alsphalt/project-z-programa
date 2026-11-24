import type { Metadata, Viewport } from "next";
import { PwaProvider } from "@/components/pwa";
import { ChristmasProvider } from "@/components/christmas/provider";
import { CrashSentinel } from "@/components/crash-sentinel";
import "./globals.css";

export const metadata: Metadata = {
  title: "Darknote Control Center",
  description: "Remote administration for the Darknote WhatsApp bot on Pterodactyl",
  applicationName: "Darknote Control Center",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Darknote",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh antialiased">
        <ChristmasProvider>
          <PwaProvider>
            {/* Records a heartbeat while the console is alive, so a renderer that
                is killed without unloading is reported on the next launch with
                the last known heap, page and session age. */}
            <CrashSentinel />
            {children}
          </PwaProvider>
        </ChristmasProvider>
      </body>
    </html>
  );
}
