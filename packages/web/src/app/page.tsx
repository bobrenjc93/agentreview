import { PasteArea } from "@/components/PasteArea";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-4xl font-bold mb-2">AgentReview</h1>
      <p className="text-gray-400 mb-8">
        Paste your agentreview payload below to start reviewing
      </p>
      <PasteArea />
    </main>
  );
}
