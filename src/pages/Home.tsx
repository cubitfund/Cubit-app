// Home — landing + swap. Section order is intentional:
// Hero → HowItWorks → HeroNumber → Chart → Breakeven. Do NOT reorder without reason.
// All sections read the same live store instance passed down as `store`.
import { useStore } from "../Root";
import { Hero } from "../components/Hero";
import { HeroNumber } from "../components/HeroNumber";
import { Chart } from "../components/Chart";
import { Breakeven } from "../components/Breakeven";
import { HowItWorks } from "../components/HowItWorks";

export function Home() {
  const store = useStore();
  return (
    <>
      <Hero store={store} />
      <HowItWorks />
      <HeroNumber store={store} />
      <Chart store={store} />
      <Breakeven store={store} />
    </>
  );
}
