<script>
  import { Progress } from "bits-ui";
  import { cn } from "../../utils.js";

  let { class: className = "", value = null, max = 100, ...rest } = $props();
</script>

<Progress.Root
  {value}
  {max}
  class={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}
  {...rest}
>
  <div
    class="h-full flex-1 rounded-full bg-primary transition-transform"
    style={`transform: translateX(-${100 - (100 * (value ?? 0)) / max}%)`}
  ></div>
</Progress.Root>
