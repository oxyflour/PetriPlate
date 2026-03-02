async function getMessage(): Promise<string> {
  'use client'
  console.log(process.pid)
  return "ok4";
}

export default async function Page() {
  const message = await getMessage();
  return (
    <main>
      <h1>Hello {message}</h1>
    </main>
  );
}
