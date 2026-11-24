import { waitForShutdown } from '../../cli';

describe('neuralbrain restart: waitForShutdown', () => {
  it('returns true as soon as the old service stops answering', async () => {
    const answers = [true, true, false];
    let calls = 0;
    const down = await waitForShutdown(async () => answers[calls++] ?? false, 1000, 1);
    expect(down).toBe(true);
    expect(calls).toBe(3);
  });

  it('returns true immediately when nothing was running', async () => {
    let calls = 0;
    const down = await waitForShutdown(async () => {
      calls++;
      return false;
    }, 1000, 1);
    expect(down).toBe(true);
    expect(calls).toBe(1);
  });

  it('gives up (so restart never starts a second copy) when the port keeps answering', async () => {
    const started = Date.now();
    const down = await waitForShutdown(async () => true, 50, 5);
    expect(down).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
