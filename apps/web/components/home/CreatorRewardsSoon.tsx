import { MoneyBag } from "./MoneyBag";

/**
 * "Get [money bag] SOON" after the home hero's punchline. Creator rewards don't exist yet, so the
 * tag says so, and nothing here claims anyone is paid today.
 */
export const CREATOR_REWARDS_NOTE = "Creator rewards are coming. Details soon.";

export function CreatorRewardsSoon() {
  return (
    <span className="gx-get" title={CREATOR_REWARDS_NOTE} data-testid="creator-rewards">
      Get
      <MoneyBag />
      <span className="gx-soon" aria-hidden>
        Soon
      </span>
      <span className="sr-only"> creator rewards. {CREATOR_REWARDS_NOTE}</span>
    </span>
  );
}
