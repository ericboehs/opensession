import type { Metadata } from "next";
import "../../.demo-tailwind.css";
import "../../product-demo.css";
import { ProductDemoEntry } from "../legacy-entry";

export const metadata: Metadata = {
  title: "Open Session product preview",
  robots: { index: false, follow: false },
};

export default function ProductDemoPage() {
  return <ProductDemoEntry />;
}
