import { StoryIntake } from "./story-intake";

export default function HomePage() {
  return (
    <>
      <header className="site-header">
        <div className="shell">Story &amp; Shot Planner</div>
      </header>
      <main className="shell">
        <div className="intro">
          <h1>Start with your story</h1>
          <p>Bring a one-line idea or a finished story to plan your short film.</p>
        </div>
        <StoryIntake />
      </main>
    </>
  );
}
