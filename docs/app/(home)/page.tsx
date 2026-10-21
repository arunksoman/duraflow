import Link from 'next/link';
import { Screenshot } from '@/components/screenshot';

const features = [
  {
    title: 'Build visually, keep the DSL honest',
    body: 'The canvas is drawn from Zigflow YAML and written back to it. Loops, parallel branches and try/catch render inline, to any depth.',
  },
  {
    title: 'Real runs on Temporal',
    body: 'Saving starts a Zigflow worker for the workflow. Runs are real Temporal executions, with durable timers, retries and child workflows.',
  },
  {
    title: 'See every run',
    body: 'The canvas lights up with the path a run took. Inspect any step’s input, output and the variables it changed, attempt by attempt.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-4 py-16">
      <section className="flex flex-col items-center gap-5 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Duraflow</h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          Design durable workflows visually, then watch every run unfold on the same canvas.
          Open source, built on Zigflow and Temporal.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs/getting-started/installation"
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            Get started
          </Link>
          <Link href="/docs" className="rounded-lg border px-4 py-2 text-sm font-medium">
            Read the docs
          </Link>
        </div>
      </section>

      <Screenshot
        name="builder-overview"
        alt="The Duraflow builder with a workflow containing a loop, a fork and a try/catch"
      />

      <section className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border bg-fd-card p-5">
            <h2 className="mb-2 font-semibold">{f.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
