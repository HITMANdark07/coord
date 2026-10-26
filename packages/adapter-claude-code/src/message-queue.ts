/** A push-based async iterable: what the SDK reads as the session's streaming input. */
export function createMessageQueue<T>() {
  const items: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;

  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };

  return {
    iterable,
    /** Returns false (and drops the item) once the input has ended. */
    push(item: T): boolean {
      if (ended) return false;
      items.push(item);
      wake?.();
      return true;
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}
