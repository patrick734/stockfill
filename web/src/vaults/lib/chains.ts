import { addressUrl } from "@/lib/config";

export function explorerAddress(address: string) {
  return addressUrl(address);
}
