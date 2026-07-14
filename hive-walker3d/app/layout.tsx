export const metadata = {
  title: '3D Walking Simulator',
  description: 'A 3D walking simulator with a third-person camera.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
