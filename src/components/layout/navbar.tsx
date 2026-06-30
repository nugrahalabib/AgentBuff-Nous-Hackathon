"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Moon, Sun, Globe, LogIn, LogOut } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import Image from "next/image";
import { useSession, signOut } from "next-auth/react";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/constants";
import { useI18n } from "@/lib/i18n/context";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { locale, setLocale, t } = useI18n();
  const pathname = usePathname();
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    setMounted(true);
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleLogout = () => {
    queryClient.clear();
    clearAgentbuffClientState();
    signOut({ callbackUrl: "/" });
  };

  const navItems = [
    { label: t.nav.home, href: "/", scrollTop: true },
    { label: t.nav.features, href: "#fitur", scrollTop: false },
    { label: t.nav.pricing, href: "#item-shop", scrollTop: false },
    { label: t.nav.faq, href: "#faq", scrollTop: false },
  ];

  const toggleLocale = () => {
    setLocale(locale === "id" ? "en" : "id");
  };

  return (
    <header
      className={cn(
        "fixed top-0 z-50 w-full transition-all duration-300",
        scrolled
          ? "border-b border-border/50 bg-background/80 shadow-sm backdrop-blur-xl"
          : "bg-transparent"
      )}
    >
      <nav aria-label="Navigasi utama" className="relative mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2"
          onClick={(e) => {
            if (pathname === "/") {
              e.preventDefault();
              scrollToTop();
            }
          }}
        >
          <Image
            src="/images/logo.png"
            alt={siteConfig.name}
            width={32}
            height={32}
            className="size-8 rounded-lg"
          />
          <span className="text-lg font-bold">{siteConfig.name}</span>
        </Link>

        {/* Desktop Nav — absolutely centered so it stays dead-center on the
            viewport regardless of how wide the logo (left) or actions (right)
            groups are. justify-between alone skews it left because the right
            group is much wider than the logo. */}
        <div className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 md:flex">
          {navItems.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              onClick={(e) => {
                if (item.scrollTop && pathname === "/") {
                  e.preventDefault();
                  scrollToTop();
                }
              }}
              className="px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </div>

        {/* Desktop Actions */}
        <div className="hidden items-center gap-2 md:flex">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleLocale}
            className="gap-1.5 text-xs font-medium"
          >
            <Globe className="size-3.5" />
            {locale === "id" ? "ID" : "EN"}
          </Button>

          {mounted && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          )}

          {session ? (
            <>
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700" asChild>
                <Link href="/app">{t.nav.goToBasecamp}</Link>
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleLogout}>
                <LogOut className="size-4" />
                {t.nav.logout}
              </Button>
            </>
          ) : (
            <>
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700" asChild>
                <Link href="/register">{t.nav.freeTrial}</Link>
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <Link href="/login">
                  <LogIn className="size-4" />
                  {t.nav.login}
                </Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile Menu */}
        <div className="flex items-center gap-1 md:hidden">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleLocale}
            className="gap-1 text-xs"
          >
            <Globe className="size-3.5" />
            {locale === "id" ? "ID" : "EN"}
          </Button>
          {mounted && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          )}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[280px] border-border/40 bg-background/95 backdrop-blur-xl sm:w-[320px]">
              <SheetTitle className="sr-only">Navigation menu</SheetTitle>
              <div className="flex items-center gap-2 border-b border-border/30 px-1 pb-4 pt-2">
                <Image src="/images/logo.png" alt={siteConfig.name} width={28} height={28} className="size-7 rounded-md" />
                <span className="font-display text-base font-bold tracking-tight">{siteConfig.name}</span>
              </div>
              <div className="flex flex-col gap-1 py-4">
                {navItems.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    onClick={(e) => {
                      setOpen(false);
                      if (item.scrollTop && pathname === "/") {
                        e.preventDefault();
                        scrollToTop();
                      }
                    }}
                    className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
              <div className="mt-auto flex flex-col gap-2.5 border-t border-border/30 pt-4">
                  {session ? (
                    <>
                      <Button
                        className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                        asChild
                      >
                        <Link href="/app" onClick={() => setOpen(false)}>
                          {t.nav.goToBasecamp}
                        </Link>
                      </Button>
                      <Button
                        variant="outline"
                        className="w-full gap-1.5"
                        onClick={() => { setOpen(false); handleLogout(); }}
                      >
                        <LogOut className="size-4" />
                        {t.nav.logout}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                        asChild
                      >
                        <Link href="/register" onClick={() => setOpen(false)}>
                          {t.nav.freeTrial}
                        </Link>
                      </Button>
                      <Button variant="outline" className="w-full gap-1.5" asChild>
                        <Link href="/login" onClick={() => setOpen(false)}>
                          <LogIn className="size-4" />
                          {t.nav.login}
                        </Link>
                      </Button>
                    </>
                  )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </header>
  );
}
