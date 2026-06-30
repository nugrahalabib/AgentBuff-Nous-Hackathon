export interface Dictionary {
  nav: {
    home: string;
    features: string;
    pricing: string;
    itemShop: string;
    faq: string;
    freeTrial: string;
    login: string;
    goToBasecamp: string;
    logout: string;
    skipToContent: string;
  };

  hero: {
    badge: string;
    titleLine1: string;
    titleLine3: string;
    titleLine4: string;
    subtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
    trustNoCreditCard: string;
    trustSetup: string;
    trustCancel: string;
    suitedFor: string;
    audiences: readonly string[];
    problemSolutionTitle: string;
    problemSolutions: readonly {
      problem: string;
      solution: string;
    }[];
    rotatingRoles: readonly {
      text: string;
      emoji: string;
      tagline: string;
      badges: readonly { value: string; label: string }[];
    }[];
    demoModal: {
      title: string;
      subtitle: string;
      cta: string;
      close: string;
    };
  };

  modelMarquee: {
    title: string;
    highlight: string;
  };

  statusPanel: {
    tabDebuff: string;
    tabBuff: string;
    debuffBadge: string;
    debuffTitle: string;
    debuffTitleHighlight: string;
    debuffSubtitle: string;
    debuffStatus: string;
    debuffSystemOverloaded: string;
    debuffUnread: string;
    debuffStats: readonly { label: string; desc: string }[];
    buffBadge: string;
    buffTitlePrefix: string;
    buffTitle: string;
    buffSubtitle: string;
    buffStatus: string;
    buffStats: readonly { label: string; desc: string }[];
    buffSystemOnline: string;
    buffOnFlash: string;
    autoLabel: string;
  };

  skillTree: {
    badge: string;
    title: string;
    titleMid: string;
    titleMidHighlight: string;
    titleHighlight: string;
    subtitle: string;
    agents: readonly {
      name: string;
      class: string;
      description: string;
    }[];
    ctaEquip: string;
    ctaDetail: string;
    notFound: string;
    notFoundSub: string;
    ctaBrowseAll: string;
    ctaTrial: string;
  };

  customAgent: {
    headingTop: string;
    headingHighlight: string;
    subtitle: string;
    subtitleHighlight: string;
    steps: readonly {
      title: string;
      desc: string;
    }[];
    cta: string;
  };


  wallOfFame: {
    badge: string;
    title: string;
    titleHighlight: string;
    subtitle: string;
    ctaMore: string;
    reviews: readonly {
      name: string;
      role: string;
      quote: string;
      rating: number;
      buff: string;
      metric: string;
      metricLabel: string;
    }[];
    stats: readonly {
      value: string;
      label: string;
    }[];
  };

  itemShop: {
    badge: string;
    title: string;
    titleHighlight: string;
    subtitle: string;
    toggleMonthly: string;
    toggleYearly: string;
    saveLabel: string;
    popularLabel?: string;
    tiers: readonly {
      name: string;
      price: string;
      priceYearly: string;
      period: string;
      periodYearly: string;
      target: string;
      features: readonly string[];
      cta: string;
      highlighted: boolean;
      savedLabel?: string;
    }[];
    guarantee: string;
    freeTrialBanner: {
      badge: string;
      title: string;
      desc: string;
      cta: string;
    };
    earlyAccess: {
      title: string;
      subtitle: string;
      nameLabel: string;
      namePlaceholder: string;
      emailLabel: string;
      emailPlaceholder: string;
      whatsappLabel: string;
      whatsappPlaceholder: string;
      noteLabel: string;
      notePlaceholder: string;
      submit: string;
      submitting: string;
      successTitle: string;
      successBody: string;
      close: string;
      errorRequired: string;
      errorEmail: string;
      errorRateLimited: string;
      errorGeneric: string;
    };
  };

  plans: {
    monthly: string;
    yearly: string;
    yearlySaveTag: string;
    perMonth: string;
    perYear: string;
    free: string;
    custom: string;
    saveMonthsPrefix: string;
    saveMonthsSuffix: string;
    badge: {
      popular: string;
      comingSoon: string;
      enterprise: string;
    };
    cta: {
      choosePrefix: string;
      active: string;
      current: string;
      earlyAccess: string;
      enterprise: string;
      renew: string;
    };
    trialBadgePrefix: string;
    tiers: {
      starter: { name: string; tagline: string; features: readonly string[] };
      op_buff: { name: string; tagline: string; features: readonly string[] };
      full_managed: { name: string; tagline: string; features: readonly string[] };
      guild_master: { name: string; tagline: string; features: readonly string[] };
    };
  };


  vsComparison: {
    badge: string;
    title: string;
    titleHighlight: string;
    subtitle: string;
    leftLabel: string;
    rightLabel: string;
    rows: readonly {
      category: string;
      left: string;
      right: string;
    }[];
    conclusion: string;
  };











  faq: {
    badge: string;
    title: string;
    subtitle: string;
    items: readonly {
      question: string;
      answer: string;
    }[];
  };

  auth: {
    backToHome: string;
    badge: string;
    badgeLogin: string;
    liveStat: string;
    mascotCaption: string;
    mascotCaptionLogin: string;
    mascotSubCaption: string;
    mascotSubCaptionLogin: string;
    chips: readonly { icon: string; label: string }[];
    chipsLogin: readonly { icon: string; label: string }[];
    ariaShowPassword: string;
    ariaHidePassword: string;
    validation: {
      emailRequired: string;
      emailInvalid: string;
      passwordMin: string;
      nameRequired: string;
      emailExists: string;
      invalidCredentials: string;
      serverError: string;
    };
    login: {
      headline: string;
      headlineHighlight: string;
      subheadline: string;
      google: string;
      divider: string;
      emailLabel: string;
      emailPlaceholder: string;
      passwordLabel: string;
      passwordPlaceholder: string;
      forgot: string;
      forgotTitle: string;
      forgotEmailPlaceholder: string;
      forgotSubmit: string;
      forgotSubmitting: string;
      forgotSuccess: string;
      forgotBack: string;
      cta: string;
      ctaLoading: string;
      switchPrompt: string;
      switchLink: string;
      agreement: string;
      oauthError: string;
    };
    register: {
      headline: string;
      headlineHighlight: string;
      subheadline: string;
      google: string;
      divider: string;
      nameLabel: string;
      namePlaceholder: string;
      emailLabel: string;
      emailPlaceholder: string;
      passwordLabel: string;
      passwordPlaceholder: string;
      cta: string;
      ctaLoading: string;
      switchPrompt: string;
      switchLink: string;
      agreement: string;
      agreementTerms: string;
      agreementAnd: string;
      agreementPrivacy: string;
      needConsentNotice: string;
    };
    perks: readonly {
      title: string;
      desc: string;
    }[];
  };

  trialLock: {
    badge: string;
    headline: string;
    body: string;
    payCta: string;
    note: string;
    logoutLabel: string;
    /** Copy variant shown when the lock is due to a lapsed subscription
     *  (vs. an ended trial). payCta / note / logoutLabel are shared. */
    subscription: {
      badge: string;
      headline: string;
      body: string;
    };
  };

  onboarding: {
    progressLabel: string;
    backLabel: string;
    exitLabel: string;
    restartLabel: string;
    restartConfirm: string;
    restartCancel: string;
    stepOf: string;
    stepsLeftLabel: string;
    lastStepLabel: string;
    stepperNavLabel: string;
    stepLabels: readonly string[];
    kenalan: {
      headline: string;
      subheadline: string;
      nicknameLabel: string;
      nicknamePlaceholder: string;
      dobLabel: string;
      dobNote: string;
      countryLabel: string;
      countryPlaceholder: string;
      countryOtherPlaceholder: string;
      cityLabel: string;
      cityPlaceholder: string;
      cityNote: string;
      cityOtherPlaceholder: string;
      referralLabel: string;
      referralPlaceholder: string;
      referralOtherPlaceholder: string;
      otherLabel: string;
      referrals: readonly { id: string; label: string }[];
      cta: string;
    };
    peran: {
      headline: string;
      subheadline: string;
      roleLabel: string;
      rolePlaceholder: string;
      roleOtherPlaceholder: string;
      jurusanLabel: string;
      jurusanPlaceholder: string;
      jurusanOtherPlaceholder: string;
      industryLabel: string;
      bidangUsahaLabel: string;
      bidangPekerjaanLabel: string;
      businessNameLabel: string;
      businessNamePlaceholder: string;
      businessNameNote: string;
      companyNameLabel: string;
      companyNamePlaceholder: string;
      teamSizeLabel: string;
      teamSizePlaceholder: string;
      teamSizes: readonly { id: string; label: string }[];
      cta: string;
    };
    quest: {
      headline: string;
      subheadline: string;
      counterLabel: string;
      maxNote: string;
      cta: string;
    };
    forge: {
      headline: string;
      subheadline: string;
      goalsRecapLabel: string;
      goalsRecapEmpty: string;
      sectionWho: string;
      sectionStyle: string;
      nameLabel: string;
      namePlaceholder: string;
      emojiLabel: string;
      emojiPickAria: string;
      titlesLabel: string;
      titlesNote: string;
      titlesCustomPlaceholder: string;
      addLabel: string;
      removeTitleAria: string;
      addressPreviewLabel: string;
      toneLabel: string;
      personalityLabel: string;
      personalityNote: string;
      advancedLabel: string;
      languageLabel: string;
      emojiUsageLabel: string;
      responseStyleLabel: string;
      previewLabel: string;
      previewHint: string;
      cta: string;
    };
    byok: {
      headline: string;
      subheadline: string;
      intro: string;
      securityNote: string;
      providerLabel: string;
      recommendedBadge: string;
      freeBadge: string;
      cheapBadge: string;
      paidBadge: string;
      tierFree: string;
      tierCheap: string;
      tierPaid: string;
      keyLabel: string;
      keyPlaceholder: string;
      showKeyAria: string;
      hideKeyAria: string;
      oauthSoon: string;
      connectCta: string;
      connectingLabel: string;
      connectedLabel: string;
      connectedHint: string;
      modelsLabel: string;
      invalidKeyLabel: string;
      getKeyLabel: string;
      changeLabel: string;
      whyTitle: string;
      whyBody: string;
      cta: string;
      // Live (container-connected) BYOK step
      loadingProviders: string;
      retryLoad: string;
      connectedCount: string;
      oauthSectionLabel: string;
      keySectionLabel: string;
      oauthConnected: string;
      oauthLogin: string;
      oauthOpenLink: string;
      oauthWaiting: string;
      oauthCode: string;
      oauthPastePlaceholder: string;
      oauthSubmit: string;
      oauthCancel: string;
      keySet: string;
      setKey: string;
      preparingTitle: string;
      preparingBody: string;
      guideTitle: string;
      guideBody: string;
      explainTitle: string;
      explainIntro: string;
      explainParas: { lead: string; text: string }[];
      explainBullets: { label: string; text: string }[];
      methodOauthLabel: string;
      methodOauthHint: string;
      methodKeyLabel: string;
      methodKeyHint: string;
      explainMore: string;
      recommendedStart: string;
      loadTimeout: string;
      copyCode: string;
      oauthApprove: string;
    };
    activate: {
      headline: string;
      subheadline: string;
      summaryTitle: string;
      agentLabel: string;
      providerSummaryLabel: string;
      connectedGeneric: string;
      trialTitle: string;
      trialBody: string;
      launchCta: string;
      launchingLabel: string;
      provisioningTitle: string;
      provisioningBody: string;
      errorTitle: string;
      retryLabel: string;
    };
    errors: {
      incomplete: string;
      invalidKey: string;
      provisionFailed: string;
      rateLimited: string;
      network: string;
      generic: string;
    };
  };

  basecamp: {
    onboarding: {
      headline: string;
      headlineHighlight: string;
      subheadline: string;
      cta: string;
      skip: string;
      progressLabel: string;
      backLabel: string;
      identity: {
        stepLabel: string;
        headline: string;
        subheadline: string;
        fullNameLabel: string;
        fullNamePlaceholder: string;
        nicknameLabel: string;
        nicknamePlaceholder: string;
        whatsappLabel: string;
        whatsappPlaceholder: string;
        whatsappNote: string;
        dobLabel: string;
        dobNote: string;
        dobDayPlaceholder: string;
        dobMonthPlaceholder: string;
        dobYearPlaceholder: string;
        months: readonly string[];
        cta: string;
      };
      persona: {
        stepLabel: string;
        headlinePrefix: string;
        headlineSuffix: string;
        subheadline: string;
        roleLabel: string;
        rolePlaceholder: string;
        roles: readonly { id: string; label: string }[];
        industryLabel: string;
        industries: readonly { id: string; icon: string; label: string }[];
        otherChipLabel: string;
        otherIndustryPlaceholder: string;
        cta: string;
      };
      quest: {
        stepLabel: string;
        headline: string;
        subheadline: string;
        counterLabel: string;
        maxReachedNote: string;
        interests: readonly { id: string; icon: string; label: string }[];
        ctaZero: string;
        ctaOne: string;
        ctaMany: string;
        ctaMax: string;
      };
    };
    engineChoice: {
      headline: string;
      headlineHighlight: string;
      subheadline: string;
      recommendedBadge: string;
      autopilot: {
        title: string;
        tagline: string;
        description: string;
        bullets: readonly string[];
        selectLabel: string;
      };
      architect: {
        title: string;
        tagline: string;
        description: string;
        bullets: readonly string[];
        selectLabel: string;
      };
      ctaAutopilot: string;
      ctaArchitect: string;
      ctaDisabled: string;
      backLabel: string;
    };
    apiKey: {
      headline: string;
      subheadline: string;
      providerLabel: string;
      providers: readonly { id: string; label: string; placeholder: string }[];
      keyLabel: string;
      helpLink: string;
      cta: string;
      ctaLoading: string;
      invalid: string;
    };
    forging: {
      badge: string;
      headline: string;
      subheadline: string;
      progressLabel: string;
      steps: readonly { title: string; detail: string }[];
      tipsPrefix: string;
      tipsByInterest: Record<string, readonly string[]>;
      defaultTips: readonly string[];
    };
    online: {
      toastTitle: string;
      toastSubtitle: string;
    };
    bridge: {
      eyebrow: string;
      headline: string;
      subheadline: string;
      qrLoading: string;
      qrReadyHint: string;
      qrExpiredTitle: string;
      qrExpiredNote: string;
      refreshCta: string;
      stepsTitle: string;
      steps: readonly { icon: string; title: string; detail: string }[];
      expiresIn: string;
      cancelLabel: string;
      simulateLabel: string;
      linkingLabel: string;
      retryNote: string;
      supportFlagNote: string;
      devicePickerLabel: string;
      devicePresets: readonly string[];
      linkedTitle: string;
      linkedSubtitle: string;
      autoGreetingPrefix: string;
      autoGreetingBody: string;
      // Multi-channel picker (STEP 3.9)
      pickerTitle: string;
      pickerSubtitle: string;
      comingSoon: string;
      skipCta: string;
      qrModalTitle: string;
      qrModalSubtitle: string;
      qrInstructions: string;
      cancelCta: string;
      submitCta: string;
      submitLoading: string;
    };
    firstMission: {
      eyebrow: string;
      coachMarkTitle: string;
      coachMarkBody: string;
      bonusLabel: string;
      suggestionsTitle: string;
      suggestionsByInterest: Record<
        string,
        readonly { icon: string; label: string; prompt: string }[]
      >;
      defaultSuggestions: readonly {
        icon: string;
        label: string;
        prompt: string;
      }[];
      skipLabel: string;
    };
    focusAreas: readonly {
      id: string;
      icon: string;
      title: string;
      desc: string;
    }[];
    topbar: {
      greetingPrefix: string;
      greetingSuffix: string;
      defaultName: string;
      energyLabel: string;
      energyComingSoon: string;
      levelUp: string;
      searchPlaceholder: string;
      commandPalette: {
        title: string;
        placeholder: string;
        noResults: string;
      };
      avatarMenu: {
        profile: string;
        logout: string;
      };
    };
    notifications: {
      title: string;
      markAllRead: string;
      tabs: readonly { id: string; icon: string; label: string }[];
      emptyIcon: string;
      emptyText: string;
      timeJustNow: string;
      timeMinutesAgo: string;
      timeHoursAgo: string;
      timeDaysAgo: string;
      whatsAppSynced: string;
      items: readonly {
        id: string;
        tab: "tasks" | "system" | "store";
        icon: string;
        text: string;
        time: string;
        read: boolean;
        highPriority?: boolean;
        action?: {
          label: string;
          href: string;
        };
      }[];
    };
    sidebar: {
      brandTag: string;
      collapse: string;
      newThread: string;
      newThreadToast: string;
      upgradeTitle: string;
      upgradeDesc: string;
      upgradeCta: string;
      planActiveTitle: string;
      planActiveDesc: string;
      logout: string;
      items: readonly {
        id: string;
        icon: string;
        label: string;
        badge?: string;
      }[];
    };
    center: {
      eyebrow: string;
      title: string;
      titleHighlight: string;
      subtitle: string;
      placeholder: string;
      send: string;
      chipsLabel: string;
      chipUse: string;
      disclaimer: string;
    };
    quickActionsByFocus: Record<
      string,
      readonly { icon: string; label: string; prompt: string }[]
    >;
    activeTeam: {
      title: string;
      subtitle: string;
      standby: string;
      executing: string;
      manage: string;
      offline: string;
      offlineHint: string;
      linkCta: string;
      loading: string;
      empty: string;
      create: string;
      noChannel: string;
      filterBy: string;
      filterClear: string;
    };
    agents: readonly {
      name: string;
      role: string;
      specialty: string;
      color: string;
    }[];
    workspace: {
      routedPrefix: string;
      thinking: string;
      draftBadge: string;
      replyPlaceholder: string;
      send: string;
      close: string;
      sampleResponseTitle: string;
      sampleResponseBody: readonly string[];
      executingSteps: readonly string[];
      executingExpand: string;
      executingCollapse: string;
      executingTitle: string;
      processingLabel: string;
      elapsedSuffix: string;
      mentionsTitle: string;
      attachLabel: string;
      voiceLabel: string;
      energyHint: string;
      lowEnergyWarning: string;
      topUpCta: string;
      tollPrefix: string;
      tollSuffix: string;
      canvasTabChat: string;
      canvasTabResult: string;
      canvasArtifactBadge: string;
      canvasFooterExport: string;
      canvasFooterForwardWa: string;
      canvasFooterRevise: string;
      canvasCopyCode: string;
      canvasCopiedToast: string;
      canvasFileNames: {
        text: string;
        table: string;
        code: string;
      };
      sampleArtifact: {
        text: { title: string; body: readonly string[] };
        table: {
          title: string;
          headers: readonly string[];
          rows: readonly (readonly string[])[];
          footnote: string;
        };
        code: { title: string; language: string; lines: readonly string[] };
      };
    };
    shop: {
      eyebrow: string;
      title: string;
      titleHighlight: string;
      subtitle: string;
      searchPlaceholder: string;
      filterAll: string;
      filterPills: readonly { id: string; label: string; icon?: string }[];
      sortLabel: string;
      sortOptions: readonly { id: string; label: string }[];
      trendingEyebrow: string;
      heroSlides: readonly {
        id: string;
        badge: string;
        title: string;
        subtitle: string;
        cta: string;
        accent: "cyan" | "fuchsia" | "amber" | "emerald";
        cover: string;
      }[];
      resultsLabel: string;
      emptyTitle: string;
      emptySubtitle: string;
      free: string;
      energyUnit: string;
      monthly: string;
      byPrefix: string;
      deployLabel: string;
      detailLabel: string;
      quickDeployLabel: string;
      creatorOfficial: string;
      creatorEcosystemNote: string;
      items: readonly {
        id: string;
        name: string;
        creator: string;
        creatorVerified: boolean;
        category: string;
        categoryLabel: string;
        tagline: string;
        description: string;
        cover: string;
        coverEmoji: string;
        accent: "cyan" | "fuchsia" | "amber" | "emerald" | "violet" | "rose";
        rating: number;
        deploys: string;
        price:
          | { type: "free" }
          | { type: "oneTime"; energy: number }
          | { type: "subscription"; energy: number };
        featured?: boolean;
        capabilities: readonly string[];
        compatible: boolean;
        reviews: readonly {
          name: string;
          rank: string;
          quote: string;
          rating: number;
        }[];
      }[];
      deployedToast: string;
    };
    itemDetail: {
      closeLabel: string;
      compatibleLabel: string;
      notCompatibleLabel: string;
      aboutTitle: string;
      capabilitiesTitle: string;
      reviewsTitle: string;
      ratingLabel: string;
      deploysLabel: string;
      creatorPrefix: string;
      stickyBalanceLabel: string;
      stickyPriceLabel: string;
      ctaDeploy: string;
      ctaTopup: string;
      ctaFree: string;
      insufficientNote: string;
    };
    energyVault: {
      title: string;
      subtitle: string;
      balanceLabel: string;
      balanceUnit: string;
      healthLabel: string;
      healthHintPrefix: string;
      healthHintSuffix: string;
      bundlesTitle: string;
      bestSellerLabel: string;
      bestValueLabel: string;
      bonusLabel: string;
      priceUnit: string;
      perEnergy: string;
      bundles: readonly {
        id: string;
        name: string;
        tier: "starter" | "grinder" | "whale";
        energy: number;
        bonusEnergy: number;
        priceIDR: number;
        highlight?: string;
      }[];
      paymentMethodsTitle: string;
      paymentMethodsNote: string;
      qrisTitle: string;
      qrisSubtitle: string;
      qrisExpiry: string;
      qrisCancel: string;
      qrisPoll: string;
      successTitle: string;
      successSubtitle: string;
      successCta: string;
      buyNowCta: string;
      closeLabel: string;
      openCta: string;
    };
    hardwareStore: {
      eyebrow: string;
      title: string;
      subtitle: string;
      storageLabel: string;
      storageUsedLabel: string;
      storageWarning: string;
      storageOk: string;
      storageSegments: readonly { label: string; pct: number; color: string }[];
      upgrades: readonly {
        id: string;
        title: string;
        tagline: string;
        description: string;
        priceIDR: number;
        pricePeriod: string;
        bullets: readonly string[];
        cta: string;
        accent: "cyan" | "fuchsia" | "amber";
        icon: string;
      }[];
      footerNote: string;
    };
    commandCenter: {
      eyebrow: string;
      title: string;
      titleHighlight: string;
      nav: readonly {
        id: string;
        icon: string;
        label: string;
        badge?: string;
      }[];
      profile: {
        title: string;
        avatarChangeLabel: string;
        avatarHint: string;
        badgeActive: string;
        badgeInactive: string;
        personalTitle: string;
        legalNameLabel: string;
        legalNameHint: string;
        legalNameLocked: string;
        displayNameLabel: string;
        displayNameHint: string;
        displayNamePlaceholder: string;
        emailLabel: string;
        emailVerified: string;
        waLabel: string;
        waHint: string;
        waPlaceholder: string;
        waCountryCode: string;
        waOtpCta: string;
        waOtpSent: string;
        waOtpPlaceholder: string;
        waOtpVerifyCta: string;
        waOtpVerified: string;
        waOtpExpired: string;
        waOtpResend: string;
        waChangeCta: string;
        avatarPickerTitle: string;
        businessTitle: string;
        businessSubtitle: string;
        roleLabel: string;
        rolePlaceholder: string;
        roles: readonly { id: string; label: string }[];
        industryLabel: string;
        industryPlaceholder: string;
        industries: readonly { id: string; label: string }[];
        saveCta: string;
        saveDisabledHint: string;
        savingLabel: string;
        savedToast: string;
        dangerTitle: string;
        dangerDeleteCta: string;
        dangerDeleteModal: {
          title: string;
          description: string;
          warning: string;
          confirmLabel: string;
          confirmPlaceholder: string;
          confirmWord: string;
          cancelLabel: string;
          deleteCta: string;
          deletingLabel: string;
        };
      };
      engine: {
        title: string;
        subtitle: string;
        modeLabel: string;
        modeSubtitle: string;
        modes: readonly {
          id: "autopilot" | "architect";
          icon: string;
          title: string;
          subtitle: string;
          bullets: readonly string[];
          accent: string;
        }[];
        modeActiveLabel: string;
        modeSwitchCta: string;
        modeSwitchModal: {
          title: string;
          description: string;
          confirmCta: string;
          cancelCta: string;
        };
        vaultTitle: string;
        vaultSubtitle: string;
        vaultHiddenNote: string;
        providers: readonly {
          id: string;
          name: string;
          logo: string;
          models: readonly string[];
        }[];
        addKeyLabel: string;
        editKeyLabel: string;
        removeKeyLabel: string;
        keyPlaceholder: string;
        keyMasked: string;
        keyRevealLabel: string;
        validateCta: string;
        validatingLabel: string;
        validatedToast: string;
        validationErrorToast: string;
        keyStatusConnected: string;
        keyStatusDisconnected: string;
        keyStatusNone: string;
        commLinkTitle: string;
        commLinkSubtitle: string;
        waCard: {
          title: string;
          statusOnline: string;
          statusOffline: string;
          linkedLabel: string;
          deviceLabel: string;
          numberLabel: string;
          disconnectCta: string;
          disconnectCountdown: string;
          reconnectCta: string;
          qrModalTitle: string;
          qrModalSubtitle: string;
          qrModalExpiry: string;
          qrModalCancel: string;
          qrModalConnected: string;
        };
        advancedTitle: string;
        advancedToggle: string;
        webhookLabel: string;
        webhookHint: string;
        webhookUrl: string;
        webhookCopyCta: string;
        webhookCopiedToast: string;
        apiBaseLabel: string;
        apiBaseHint: string;
        apiBaseUrl: string;
      };
      billing: {
        title: string;
        subtitle: string;
        failedBanner: {
          text: string;
          cta: string;
        };
        vpsCard: {
          statusActive: string;
          statusExpired: string;
          planLabel: string;
          renewLabel: string;
          changePlanCta: string;
          cancelCta: string;
        };
        energyCard: {
          label: string;
          unit: string;
          estimatePrefix: string;
          estimateSuffix: string;
          topUpCta: string;
        };
        cancelModal: {
          title: string;
          description: string;
          freezeTitle: string;
          freezeDescription: string;
          freezePrice: string;
          freezeCta: string;
          confirmCta: string;
          keepCta: string;
        };
        paymentTitle: string;
        paymentSubtitle: string;
        paymentAddCta: string;
        paymentDefaultLabel: string;
        paymentExpiry: string;
        paymentRemoveLabel: string;
        paymentRemoveConfirm: string;
        paymentRemovedToast: string;
        paymentAddedToast: string;
        changePlanToast: string;
        addPaymentModal: {
          title: string;
          cardNumber: string;
          expiry: string;
          cvv: string;
          saveCta: string;
        };
        paymentMethods: readonly {
          id: string;
          type: string;
          icon: string;
          label: string;
          detail: string;
          expiry: string;
          isDefault: boolean;
        }[];
        ledgerTitle: string;
        ledgerSubtitle: string;
        ledgerExportCsv: string;
        ledgerExportedToast: string;
        ledgerFilterPeriod: readonly { id: string; label: string }[];
        ledgerFilterCategory: readonly { id: string; label: string }[];
        ledgerColumnDate: string;
        ledgerColumnDescription: string;
        ledgerColumnAmount: string;
        ledgerColumnStatus: string;
        ledgerColumnAction: string;
        ledgerStatusSuccess: string;
        ledgerStatusFailed: string;
        ledgerStatusPending: string;
        ledgerDownloadPdf: string;
        ledgerEmpty: string;
        ledgerTransactions: readonly {
          id: string;
          date: string;
          description: string;
          icon: string;
          amount: string;
          amountType: "rupiah" | "energy";
          status: "success" | "failed" | "pending";
          category: "subscription" | "topup" | "shop";
        }[];
      };
      notificationSettings: {
        title: string;
        subtitle: string;
        prefsTitle: string;
        prefsSubtitle: string;
        prefs: readonly {
          id: string;
          icon: string;
          label: string;
          description: string;
        }[];
        whatsAppTitle: string;
        whatsAppDescription: string;
        whatsAppHighPriorityLabel: string;
        whatsAppHighPriorityHint: string;
        historyTitle: string;
        historySubtitle: string;
        filterAll: string;
        clearAllCta: string;
        clearedToast: string;
        noHistory: string;
      };
    };
    helpCenter: {
      sidebarLabel: string;
      heroEyebrow: string;
      heroTitle: string;
      heroSubtitle: string;
      searchPlaceholder: string;
      searchSuggestions: readonly {
        id: string;
        query: string;
        href: string;
      }[];
      kbTitle: string;
      kbCategories: readonly {
        id: string;
        icon: string;
        title: string;
        description: string;
        articles: readonly { id: string; title: string }[];
      }[];
      sosLabel: string;
      sosCta: string;
      ticketForm: {
        title: string;
        subtitle: string;
        urgencyLabel: string;
        urgencies: readonly {
          id: string;
          color: string;
          label: string;
          sla: string;
        }[];
        subjectLabel: string;
        subjectPlaceholder: string;
        detailLabel: string;
        detailPlaceholder: string;
        attachLabel: string;
        attachHint: string;
        smartSuggestions: readonly {
          trigger: string;
          tip: string;
        }[];
        submitCta: string;
        submittingLabel: string;
      };
      successTitle: string;
      successDescription: string;
      successTicketPrefix: string;
      successSla: string;
      successChannels: string;
      successBackCta: string;
      myTicketsTab: string;
      myTicketsEmpty: string;
      myTickets: readonly {
        id: string;
        subject: string;
        status: "open" | "in-progress" | "resolved";
        urgency: string;
        date: string;
      }[];
      ticketStatusOpen: string;
      ticketStatusInProgress: string;
      ticketStatusResolved: string;
      vipBadge: string;
      vipLabel: string;
      vipOnline: string;
      vipAutoReply: string;
      vipInputPlaceholder: string;
      vipSend: string;
    };
    forge: {
      sidebarLabel: string;
      sidebarBadge: string;
      exitLabel: string;
      saveDraftLabel: string;
      draftSavedToast: string;
      dashboard: {
        eyebrow: string;
        title: string;
        titleHighlight: string;
        subtitle: string;
        createCta: string;
        metrics: {
          earningsLabel: string;
          earningsUnit: string;
          earningsTrend: string;
          withdrawCta: string;
          withdrawModal: {
            title: string;
            amountLabel: string;
            destinationLabel: string;
            destinations: readonly string[];
            submitCta: string;
            submitting: string;
            successToast: string;
          };
          subscribersLabel: string;
          subscribersUnit: string;
          subscribersTrend: string;
          topAgentLabel: string;
          topAgentName: string;
          topAgentNote: string;
        };
        arsenalTitle: string;
        arsenalSubtitle: string;
        columnName: string;
        columnStatus: string;
        columnPrice: string;
        columnDeploys: string;
        columnEarnings: string;
        columnAction: string;
        editLabel: string;
        viewInsightsLabel: string;
        hideInsightsLabel: string;
        statusPublished: string;
        statusDraft: string;
        statusRejected: string;
        priceFree: string;
        priceOneTime: string;
        priceSubscription: string;
        energyUnit: string;
        emptyTitle: string;
        emptySubtitle: string;
        emptyCta: string;
        arsenalItems: readonly {
          id: string;
          name: string;
          icon: string;
          status: "published" | "draft" | "rejected";
          priceType: "free" | "oneTime" | "subscription";
          priceEnergy: number;
          deploys: number;
          earnings: number;
          rejectedReason?: string;
        }[];
        insightsTitle: string;
        insightsSubtitle: string;
        insightsBullets: readonly { icon: string; label: string; value: string }[];
      };
      builder: {
        eyebrow: string;
        titleNew: string;
        titleEdit: string;
        step1Label: string;
        step2Label: string;
        step3Label: string;
        nextCta: string;
        identityTitle: string;
        identitySubtitle: string;
        iconLabel: string;
        iconHint: string;
        iconPresets: readonly string[];
        uploadLabel: string;
        nameLabel: string;
        namePlaceholder: string;
        taglineLabel: string;
        taglinePlaceholder: string;
        brainLabel: string;
        brainHint: string;
        brainPlaceholder: string;
        magicPromptCta: string;
        magicPromptRunning: string;
        magicPromptDoneToast: string;
        magicPromptTemplate: string;
        skillsTitle: string;
        skillsSubtitle: string;
        knowledgeTitle: string;
        knowledgeHint: string;
        knowledgeUploadCta: string;
        knowledgeDropHint: string;
        knowledgeEmpty: string;
        knowledgeRemoveLabel: string;
        knowledgeSampleFiles: readonly { name: string; size: string; icon: string }[];
        integrationsTitle: string;
        integrationsHint: string;
        integrations: readonly {
          id: string;
          icon: string;
          label: string;
          description: string;
          accent: "cyan" | "amber" | "emerald" | "fuchsia";
          premium?: boolean;
        }[];
        premiumLabel: string;
        sandboxTitle: string;
        sandboxSubtitle: string;
        sandboxPlaceholder: string;
        sandboxSend: string;
        sandboxReset: string;
        sandboxGreeting: string;
        sandboxEmptyTitle: string;
        sandboxEmptySubtitle: string;
        sandboxSampleUser: string;
        sandboxSampleAgentIntro: string;
        sandboxSampleAgentBody: readonly string[];
        sandboxWaitingTitle: string;
        sandboxWaitingHint: string;
        debugLabel: string;
        debugHintOff: string;
        debugHintOn: string;
        debugStepsTitle: string;
        debugSteps: readonly string[];
        sandboxDisclaimer: string;
      };
      storefront: {
        eyebrow: string;
        title: string;
        subtitle: string;
        backCta: string;
        submitCta: string;
        categoryLabel: string;
        categoryPlaceholder: string;
        categories: readonly { id: string; icon: string; label: string }[];
        descriptionLabel: string;
        descriptionHint: string;
        descriptionPlaceholder: string;
        priceLabel: string;
        priceHint: string;
        priceOptions: readonly {
          id: "free" | "oneTime" | "subscription";
          icon: string;
          title: string;
          subtitle: string;
          badge?: string;
        }[];
        priceInputLabel: string;
        priceInputSuffix: string;
        priceInputSuffixSub: string;
        calculatorTitle: string;
        calculatorPriceLabel: string;
        calculatorCommissionLabel: string;
        calculatorNetLabel: string;
        calculatorCommissionPct: number;
        calculatorFreeNote: string;
        calculatorHint: string;
        calculatorProjectionTitle: string;
        calculatorProjectionRows: readonly { label: string; multiplier: number }[];
        previewTitle: string;
        previewHint: string;
        previewPriceFree: string;
        previewPriceOneTime: string;
        previewPriceSub: string;
      };
      review: {
        badge: string;
        title: string;
        subtitle: string;
        body: string;
        bullets: readonly { icon: string; text: string }[];
        etaLabel: string;
        etaValue: string;
        notifyLabel: string;
        notifyValue: string;
        primaryCta: string;
        secondaryCta: string;
      };
    };
    roster: {
      eyebrow: string;
      title: string;
      titleHighlight: string;
      subtitle: string;
      commandDeck: {
        coreLoadLabel: string;
        coreLoadUnit: string;
        activeAgentsLabel: string;
        activeAgentsLimit: string;
        warningThreshold: string;
        microcopy: string;
        upgradeCta: string;
      };
      viewGrid: string;
      viewList: string;
      filterAll: string;
      filterActive: string;
      filterSleeping: string;
      searchPlaceholder: string;
      emptyTitle: string;
      emptySubtitle: string;
      emptyCta: string;
      agents: readonly {
        id: string;
        name: string;
        role: string;
        icon: string;
        avatar: string;
        color: string;
        status: "active" | "sleeping";
        tasksCompleted: number;
        energyUsed: number;
        channels: readonly string[];
        source: "official" | "community";
        creator: string;
        description: string;
        customInstructions: string;
        activityLog: readonly {
          task: string;
          timestamp: string;
          energy: number;
        }[];
      }[];
      card: {
        tasksLabel: string;
        energyLabel: string;
        toggleOn: string;
        toggleOff: string;
        sleepingLabel: string;
        activeLabel: string;
        sourceOfficial: string;
        sourceCommunity: string;
        byPrefix: string;
      };
      tuningBay: {
        title: string;
        closeLabel: string;
        deleteLabel: string;
        generalTitle: string;
        descriptionLabel: string;
        creatorLabel: string;
        sourceLabel: string;
        statusLabel: string;
        whisperTitle: string;
        whisperSubtitle: string;
        whisperPlaceholder: string;
        whisperHint: string;
        whisperSaveCta: string;
        whisperSavedToast: string;
        channelTitle: string;
        channelSubtitle: string;
        channels: readonly {
          id: string;
          icon: string;
          label: string;
          description: string;
        }[];
        channelConflictWarning: string;
        channelConflictConfirm: string;
        channelConflictCancel: string;
        activityTitle: string;
        activitySubtitle: string;
        activityColumnTask: string;
        activityColumnTime: string;
        activityColumnEnergy: string;
        activityEmpty: string;
      };
      deleteModal: {
        title: string;
        description: string;
        reassurance: string;
        cancelLabel: string;
        confirmLabel: string;
      };
    };
  };

  footer: {
    tagline: string;
    product: string;
    productItemShop: string;
    productPricing: string;
    becomeSeller: string;
    playerGuide: string;
    starterPack: string;
    documentation: string;
    patchNotes: string;
    guildCommunity: string;
    followTwitter: string;
    followInstagram: string;
    followTiktok: string;
    legal: string;
    privacyPolicy: string;
    termsOfService: string;
    builtBy: string;
    madeIn: string;
  };
  errorPages: {
    notFound: {
      code: string;
      headline: string;
      subtitle: string;
      primaryCta: string;
      secondaryShop: string;
      secondaryReport: string;
      easterEggPrefix: string;
      easterEggSuffix: string;
    };
    serverError: {
      code: string;
      headline: string;
      subtitle: string;
      refreshCta: string;
      refreshingLabel: string;
      refreshCooldown: string;
      statusCta: string;
      statusUrl: string;
    };
    localError: {
      text: string;
      retryCta: string;
    };
  };
  legal: {
    bannerEyebrow: string;
    bannerTitle: string;
    bannerSubtitle: string;
    lastUpdatedPrefix: string;
    lastUpdatedDate: string;
    tocTitle: string;
    consentMicrocopy: string;
    consentLinkToS: string;
    consentLinkPrivacy: string;
    privacy: {
      metaTitle: string;
      heroTitle: string;
      sections: readonly {
        id: string;
        title: string;
        tldr: string;
        body: string;
      }[];
      pillars: readonly {
        id: string;
        icon: string;
        title: string;
        tldr: string;
        bullets: readonly string[];
        badge?: string;
      }[];
    };
    terms: {
      metaTitle: string;
      heroTitle: string;
      sections: readonly {
        id: string;
        title: string;
        tldr: string;
        body: string;
      }[];
    };
  };

  patchNotes: {
    metaTitle: string;
    eyebrow: string;
    title: string;
    subtitle: string;
    backToHome: string;
    entries: readonly {
      version: string;
      date: string;
      title: string;
      items: readonly string[];
    }[];
  };

  shared: {
    whatsappAriaLabel: string;
  };

  // ─────────────────────────────────────────────────────────────────────
  // /app control surface — 18 tabs + shared primitives.
  //
  // Structure:
  //  - nav: group labels + per-tab labels (18 tabs)
  //  - shared: text used by primitives (ListView empty state, form helpers,
  //    destructive confirm, Loadable status labels, log levels)
  //  - approvals: cross-tab banner + drawer copy
  //  - <tabId>: per-tab copy. Minimal contract is eyebrow + title + subtitle
  //    + empty + error; individual tabs extend with their own fields.
  // ─────────────────────────────────────────────────────────────────────
  app: {
    nav: {
      groups: {
        utama: string;
        markas: string;
        tim: string;
        riwayat: string;
        pengaturan: string;
      };
      tabs: {
        chat: string;
        overview: string;
        shop: string;
        sessions: string;
        usage: string;
        cron: string;
        agents: string;
        providers: string;
        pengaturan: string;
        kanban: string;
        office: string;
        galeri: string;
        riwayat: string;
      };
      sessionsHeader: string;
    };
    commandPalette: {
      placeholder: string;
      pages: string;
      sessions: string;
      newThread: string;
      empty: string;
      hint: string;
    };
    cronSidebar: {
      title: string;
      triggerNow: string;
      manage: string;
      more: string;
    };
    settings: {
      title: string;
      subtitle: string;
      navTitle: string;
      loading: string;
      error: string;
      retry: string;
      profile: {
        title: string;
        loading: string;
        emailLabel: string;
        emailLocked: string;
        status: string;
        dob: string;
        businessName: string;
        jurusan: string;
        industry: string;
        focus: string;
        notSet: string;
        account: {
          opBuff: string;
          active: string;
          cycleMonthly: string;
          cycleYearly: string;
          until: string;
          trial: string;
          daysLeftPrefix: string;
          daysLeftSuffix: string;
          upgradeCta: string;
          starter: string;
          starterDesc: string;
        };
      };
      saveBar: {
        dirty: string;
        save: string;
        saving: string;
        saved: string;
        discard: string;
        applyNote: string;
        failed: string;
      };
      danger: {
        title: string;
        desc: string;
        deleteBtn: string;
        warnTitle: string;
        warn1: string;
        warn2: string;
        warn3: string;
        confirmHint: string;
        confirmWord: string;
        confirmPlaceholder: string;
        cancel: string;
        confirm: string;
        deleting: string;
        rateLimited: string;
        error: string;
      };
      sections: {
        ai: { title: string; desc: string };
        voice: { title: string; desc: string };
        memory: { title: string; desc: string };
        safety: { title: string; desc: string };
        appearance: { title: string; desc: string };
        providers: { title: string; desc: string; cta: string };
        account: { title: string; desc: string };
      };
      fields: {
        showReasoning: { label: string; help: string };
        webToolProgress: { label: string; help: string };
        channelToolProgress: { label: string; help: string };
        voiceAutoTts: { label: string; help: string };
        ttsProvider: { label: string; help: string };
        sttEnabled: { label: string; help: string };
        timezone: { label: string; help: string; systemDefault: string };
        memoryEnabled: { label: string; help: string };
        userProfile: { label: string; help: string };
        compression: { label: string; help: string };
        approvalMode: {
          label: string;
          help: string;
          manual: string;
          smart: string;
          off: string;
          manualHint: string;
          smartHint: string;
          offHint: string;
        };
        approvalTimeout: { label: string; help: string; unit: string };
        theme: {
          label: string;
          help: string;
          light: string;
          dark: string;
          system: string;
        };
        language: { label: string; help: string };
      };
      voice: {
        ttsGroup: { title: string; desc: string };
        sttGroup: { title: string; desc: string };
        readAloud: { label: string; help: string };
        ttsProvider: { label: string; help: string };
        geminiVoice: { label: string; help: string };
        edgeVoice: { label: string; help: string };
        openaiVoice: { label: string };
        openaiModel: { label: string };
        elevenVoice: { label: string; help: string };
        elevenModel: { label: string };
        xaiVoice: { label: string; help: string };
        xaiLang: { label: string; help: string };
        mistralVoice: { label: string };
        mistralModel: { label: string };
        neuttsModel: { label: string; help: string };
        piperVoice: { label: string; help: string };
        providerDefaultNote: string;
        langAuto: string;
        sttEnabled: { label: string; help: string };
        sttProvider: { label: string; help: string };
        localModel: { label: string; help: string };
        localLang: { label: string; help: string };
        openaiStt: { label: string };
        mistralStt: { label: string };
        elevenStt: { label: string };
        elevenLang: { label: string; help: string };
        tagEvents: { label: string; help: string };
        diarize: { label: string; help: string };
        ttsProviders: Record<string, string>;
        sttProviders: Record<string, string>;
      };
      onValue: string;
      offValue: string;
    };
    galeri: {
      eyebrow: string;
      title: string;
      subtitle: string;
      refresh: string;
      filterAll: string;
      filterImage: string;
      filterAudio: string;
      filterVideo: string;
      filterDocument: string;
      search: string;
      connecting: string;
      scanning: string;
      scanningCount: string;
      scanningMore: string;
      empty: string;
      emptyHint: string;
      emptyFilter: string;
      emptyFilterHint: string;
      fromUser: string;
      fromAgent: string;
      today: string;
      yesterday: string;
      range7d: string;
      range30d: string;
      rangeCustom: string;
      rangeFrom: string;
      rangeTo: string;
      groupKind: string;
      groupDate: string;
    };
    shared: {
      loading: string;
      refreshing: string;
      error: string;
      retry: string;
      save: string;
      cancel: string;
      delete: string;
      close: string;
      open: string;
      apply: string;
      reset: string;
      copy: string;
      copied: string;
      download: string;
      tryAgain: string;
      comingSoon: string;
      comingSoonSubtitle: string;
      stale: string;
      empty: { title: string; subtitle: string };
      form: {
        required: string;
        invalid: string;
        tooLong: string;
        tooShort: string;
        placeholder: string;
      };
      destructive: {
        confirmPrompt: string;
        cancelHint: string;
        confirmHint: string;
      };
      logLevels: {
        trace: string;
        debug: string;
        info: string;
        warn: string;
        error: string;
      };
      wizard: {
        activeTitle: string;
        activeBody: string;
      };
    };
    approvals: {
      bannerSingle: string;
      bannerMulti: string;
      exec: {
        title: string;
        command: string;
        accept: string;
        reject: string;
        reasonPlaceholder: string;
      };
      plugin: {
        title: string;
        accept: string;
        reject: string;
      };
    };
    connection: {
      connecting: string;
      ready: string;
      reconnecting: string;
      closed: string;
    };
    trial: {
      pillDays: string;
      pillLastDay: string;
      bannerWarnBody: string;
      bannerUrgentBody: string;
      upgradeCta: string;
      dismiss: string;
    };
    topbar: {
      updatePill: string;
      tickIdle: string;
      clients: string;
    };
    chat: {
      buffhub: {
        trustStripe: string;
        detail: string;
        comingSoon: string;
        buy: string;
        buyNow: string;
        close: string;
        skillBadge: string;
        buffhubSkill: string;
        noResults: string;
        marketplace: string;
        skillsFound: string;
        purchaseProcessing: string;
        purchaseFailed: string;
        notPurchasedSuffix: string;
        retry: string;
        purchaseSuccess: string;
        receiptTitle: string;
        method: string;
        methodValue: string;
        date: string;
        ref: string;
        paid: string;
        fullReceipt: string;
        openPosApp: string;
        operateHint: string;
        posReportProcessing: string;
        reportWord: string;
        periodToday: string;
        revenue: string;
        transactions: string;
        posMcpLive: string;
        payingViaStripe: string;
      };
      blocks: {
        thinkingLabel: string;
        thinkingRedacted: string;
        subagentStart: string;
        subagentTool: string;
        subagentComplete: string;
        approvalTitle: string;
        approvalSuggested: string;
        approvalDetected: string;
        approvalChoiceOnce: string;
        approvalChoiceSession: string;
        approvalChoiceAlways: string;
        approvalChoiceDeny: string;
        approvalBtnOnce: string;
        approvalBtnSession: string;
        approvalBtnAlways: string;
        approvalBtnDeny: string;
        approvalSending: string;
        approvalSendFail: string;
        approvalRecommendedBadge: string;
        approvalScopeSessionLabel: string;
        approvalScopeSessionDesc: string;
        approvalScopeAlwaysLabel: string;
        approvalScopeAlwaysDesc1: string;
        approvalScopeAlwaysDesc2: string;
        approvalScopeAlwaysDesc3: string;
        approvalExpiresPrefix: string;
        approvalReasonHigh: string;
        approvalReasonMedium: string;
        approvalReasonLow: string;
        approvedOnce: string;
        approvedSession: string;
        approvedAlways: string;
        denied: string;
        approvedBy: string;
        showCode: string;
        hideCode: string;
        codeLines: string;
        clarifyOther: string;
        clarifyOtherPlaceholder: string;
        clarifySend: string;
        clarifySendFail: string;
        clarifyExpiresPrefix: string;
        unknownBlock: string;
        brokenBlock: string;
        dotRunning: string;
        dotDone: string;
        dotError: string;
        inputLabel: string;
        outputLabel: string;
        errorLabel: string;
      };
      statusPill: {
        idle: string;
        connecting: string;
        ready: string;
        reconnecting: string;
        closed: string;
      };
      banners: {
        connClosedTitle: string;
        connReconnectingTitle: string;
        connClosedHint: string;
        connReconnectingHint: string;
        reload: string;
        errTopup: string;
        errUpgrade: string;
        errLogin: string;
        errReload: string;
        errDismiss: string;
      };
      liveBar: {
        escToStop: string;
        stopAgentTitle: string;
        stopAgentAria: string;
        stop: string;
      };
      source: {
        webTooltip: string;
        channelTooltipPrefix: string;
        channelTooltipSuffix: string;
      };
      sidebar2: {
        sessionsEyebrow: string;
        newThread: string;
        chatWithAgent: string;
        defaultBadge: string;
        sessionListAria: string;
        unfoldered: string;
        toggleFolderPrefix: string;
        folderActions: string;
        dropHere: string;
        empty: string;
        renameFolder: string;
        deleteFolder: string;
        confirmDelete: string;
        folderNamePlaceholder: string;
        createFolder: string;
        cancel: string;
        newFolder: string;
        moveTo: string;
        noFoldersYet: string;
        sessionActionsPrefix: string;
        confirmDeleteSessionPrefix: string;
        deleteSessionPrefix: string;
        emptySessions: string;
      };
      header: {
        routedTo: string;
        defaultRole: string;
        statusStandby: string;
        statusExecuting: string;
        searchAriaLabel: string;
        searchPlaceholder: string;
        searchOpenLabel: string;
        searchCloseLabel: string;
        searchMatchCount: string;
        searchNoMatch: string;
        agentPickerLabel: string;
        agentPickerHelp: string;
        agentPickerLoading: string;
        agentPickerEmpty: string;
        exportLabel: string;
        exportMarkdown: string;
        exportJson: string;
        exportCopyMarkdown: string;
        exportCopyCopied: string;
        exportCopyFailed: string;
        exportEmpty: string;
      };
      composer: {
        placeholder: string;
        placeholderBusy: string;
        placeholderDrafts: string;
        placeholderDefault: string;
        placeholderNotReady: string;
        sendLabel: string;
        stopLabel: string;
        attachLabel: string;
        attachMaxTitle: string;
        voiceLabel: string;
        voiceTitle: string;
        voiceListening: string;
        voiceStopLabel: string;
        voiceUnavailable: string;
        voiceErrorPermission: string;
        voiceErrorService: string;
        voiceErrorNetwork: string;
        voiceErrorNoMic: string;
        voiceErrorGeneric: string;
        vnStartLabel: string;
        vnStopLabel: string;
        vnCancelLabel: string;
        vnDiscardLabel: string;
        vnAttachLabel: string;
        vnPlayLabel: string;
        vnPauseLabel: string;
        vnTitle: string;
        vnRecording: string;
        vnPreviewLabel: string;
        vnUnsupported: string;
        chatLabel: string;
        dropZoneHint: string;
        closeWarn: string;
        closeDraftWarn: string;
        draftWarnQuota: string;
        draftWarnOversize: string;
        draftWarnUnavailable: string;
        aborting: string;
        enterToSend: string;
        attachmentCount: string;
        busyHint: string;
        lowEnergyHint: string;
        topUpButton: string;
        costHint: string;
        balanceUnknown: string;
        removeAttachment: string;
        balanceTooltip: string;
        slashCommandsHeader: string;
        slashSummarizeLabel: string;
        slashSummarizeTemplate: string;
        slashSummarizeHint: string;
        slashBrainstormLabel: string;
        slashBrainstormTemplate: string;
        slashBrainstormHint: string;
        slashCodeLabel: string;
        slashCodeTemplate: string;
        slashCodeHint: string;
        slashTranslateLabel: string;
        slashTranslateTemplate: string;
        slashTranslateHint: string;
        slashExplainLabel: string;
        slashExplainTemplate: string;
        slashExplainHint: string;
        slashHelpLabel: string;
        slashHelpTemplate: string;
        slashHelpHint: string;
      };
      thread: {
        typingHint: string;
        newMessages: string;
        toBottom: string;
        scrollToBottomLabel: string;
        emptyTitle: string;
        emptyBody: string;
        retryChip: string;
        regenerateChip: string;
        regenerateAriaLabel: string;
        editAriaLabel: string;
        editPlaceholder: string;
        editSave: string;
        editCancel: string;
        editHint: string;
        annotationAddLabel: string;
        annotationEditLabel: string;
        annotationDeleteLabel: string;
        annotationPlaceholder: string;
        annotationSave: string;
        annotationCancel: string;
        annotationDelete: string;
        annotationEyebrow: string;
        annotationHint: string;
        forkLabel: string;
        forkAriaLabel: string;
        forkTitle: string;
        abortedNotice: string;
        errorNotice: string;
        copyAssistant: string;
        copyUser: string;
        sentAria: string;
        runningTool: string;
        emptyMessagePlaceholder: string;
        copiedToast: string;
        loadEarlierLabel: string;
        loadEarlierHint: string;
      };
      sidebar: {
        newThread: string;
        newThreadShortcut: string;
        emptyList: string;
        emptyListHint: string;
        filterScope: string;
        filterClear: string;
        filterEmpty: string;
        renameLabel: string;
        renameSession: string;
        renameEyebrow: string;
        renamePlaceholder: string;
        renameHint: string;
        deleteLabel: string;
        deleteSession: string;
        confirmDelete: string;
        deleteConfirmTitle: string;
        deleteConfirmBody: string;
        deleteCancelLabel: string;
        deleteCancelAria: string;
        deleteConfirmLabel: string;
        deleteConfirmAria: string;
        deletingHint: string;
        sessionsEyebrow: string;
        minimize: string;
        expand: string;
        save: string;
        openThread: string;
        liveSessionTitle: string;
        workingLabel: string;
        bulkSelectEnter: string;
        bulkSelectExit: string;
        bulkSelectAll: string;
        bulkClearSelection: string;
        bulkSelectedCount: string;
        bulkDelete: string;
        bulkConfirmDeleteTitle: string;
        bulkConfirmDeleteBody: string;
        bulkConfirmDeleteAction: string;
      };
    };
    overview: {
      eyebrow: string; title: string; subtitle: string;
      health: string; tick: string; presence: string; version: string;
      refresh: string; loading: string; errorTitle: string;
      engineOnline: string; engineOffline: string; engineProbing: string;
      tickActive: string; tickIdle: string; lastTick: string; heartbeatEvery: string;
      channelsHeader: string; channelsDesc: string; noChannels: string;
      statusLinked: string; statusConfigured: string; statusUnlinked: string;
      accountsCount: string;
      agentsHeader: string; agentsDesc: string; noAgents: string;
      badgeDefault: string; heartbeatOn: string; heartbeatOff: string; agentReady: string;
      sessionsHeader: string; sessionsDesc: string; noSessions: string;
      sessionCount: string; activeAgent: string; activeSession: string;
      dataAge: string; fresh: string; updatedAt: string;
      // ── New zones (Phase Ringkasan redesign) ───────────────
      greeting: {
        morning: string; afternoon: string; evening: string; night: string;
        fallbackName: string;
      };
      tier: {
        starter: string; opBuff: string; guildMaster: string;
        activeUntil: string; daysRemaining: string;
        expiringSoon: string; expired: string;
        upgradeCta: string; renewCta: string; manageCta: string;
        autoRenewOn: string; autoRenewOff: string;
      };
      energy: {
        title: string;
        balanceLabel: string; maxLabel: string;
        usedToday: string; remaining: string;
        topUpButton: string; historyButton: string;
        starterDailyHint: string;
        lowWarn: string; criticalWarn: string; exhaustedWarn: string;
        loading: string;
        comingSoonBadge: string;
        comingSoonTitle: string;
        comingSoonDesc: string;
        byokNote: string;
        /** Compact teaser strip (non-dominant) di bawah Command Center. */
        stripTitle: string;
        stripNote: string;
      };
      commandCenter: {
        eyebrow: string;
        engineOnline: string; engineReconnecting: string; engineOffline: string;
        teamReady: string; teamWorking: string; workingBadge: string;
        idleHeadline: string;
        carryPrefix: string; carryUnit: string;
        carryZeroHeadline: string; carryZeroSub: string;
        uptimePrefix: string; detailCta: string;
      };
      engineStrip: {
        statusOnline: string; statusOffline: string; statusReconnecting: string;
        pulseActive: string; pulseIdle: string;
        uptimePrefix: string; uptimeNa: string;
        viewDetails: string;
      };
      todayStats: {
        sectionTitle: string;
        taskCarry: string; taskCarryHint: string;
        weekCarryLabel: string; weekCarryHint: string;
        energyUsedLabel: string; energyUsedHint: string;
        channelsLabel: string; channelsHint: string;
        agentsLabel: string; agentsHint: string;
        freshStart: string; vsYesterday: string; noChange: string;
        offlineHint: string;
        comingSoon: string;
      };
      attention: {
        title: string; countSuffix: string;
      };
      quickActions: {
        title: string;
        newChat: string; itemShop: string; recruit: string;
        channels: string; topUp: string; quest: string;
        upgradeOpBuff: string;
      };
      activeSurface: {
        channelsTitle: string; channelsDesc: string;
        agentsTitle: string; agentsDesc: string;
        channelsEmpty: string; channelsEmptyCta: string;
        agentsEmpty: string; agentsEmptyCta: string;
        viewAllChannels: string; viewAllAgents: string;
      };
      recentActivity: {
        title: string; viewAll: string;
        empty: string; emptyHint: string;
      };
      detailEngine: {
        toggleLabel: string;
        versionLabel: string; uptimeLabel: string;
        pulseIntervalLabel: string; heartbeatAgentLabel: string;
        channelsRefreshLabel: string;
        byokTitle: string; byokAllOk: string; byokNoneConfigured: string;
        cronTitle: string; cronJobs: string; cronNextRun: string; cronFailed: string;
        systemActivity: string; viewLogsCta: string;
      };
    };
    channels: {
      eyebrow: string; title: string; subtitle: string;
      pair: string; logout: string; unlinked: string;
      refresh: string; probe: string; probing: string; probeError: string;
      accounts: string; accountsSuffix: string; noAccounts: string;
      stateLinked: string; stateConnected: string; stateDisconnected: string;
      stateConfigured: string; stateUnconfigured: string;
      stateRunning: string; stateStopped: string; stateBusy: string;
      lastConnected: string; lastInbound: string; lastOutbound: string;
      lastError: string; lastProbe: string;
      reconnectAttempts: string; activeRuns: string;
      defaultBadge: string; empty: string;
      routedTo: string;
      summaryChannels: string; summaryAccounts: string; summaryOnline: string;
      pairingHint: string;
      logoutConfirmTitle: string; logoutConfirmBody: string;
      logoutCancel: string; logoutConfirm: string; logoutAll: string;
      logoutSuccess: string; logoutFailed: string; loggingOut: string;
      detailClose: string;
      // ── New zones (Saluran redesign) ─────────────────────────
      summaryInbound: string;
      summaryOutbound: string;
      todayInbound: string;
      todayOutbound: string;
      lastActivity: string;
      noneToday: string;
      messagesTodaySuffix: string;
      testConnection: string;
      testing: string;
      configurePrivacy: string;
      addAnotherAccount: string;
      attentionTitle: string;
      attentionDisconnected: string;
      attentionReconnectLoop: string;
      attentionTokenError: string;
      attentionAction: string;
      engineBannerReconnecting: string;
      engineBannerClosed: string;
      catalogTitle: string;
      catalogSubtitle: string;
      catalogConnect: string;
      catalogTierLocked: string;
      catalogTierLockedHint: string;
      /** Badge label untuk channel yang belum siap, mis. "Segera Hadir". */
      catalogComingSoon: string;
      /** Button label di card coming-soon (disabled). */
      catalogComingSoonHint: string;
      advancedTitle: string;
      advancedSubtitle: string;
      privacyTitle: string;
      privacySubtitle: string;
      allowlistLabel: string;
      allowlistPlaceholder: string;
      allowlistHint: string;
      allowlistEmpty: string;
      allowlistInvalid: string;
      /**
       * Per-channel format guidance untuk allowlist input. Saat panel buka
       * untuk channel tertentu, override placeholder/hint dengan yang
       * channel-spesifik. Channel yang tidak ada di sini fall back ke
       * generic allowlistPlaceholder + allowlistHint.
       */
      allowlistByChannel: {
        whatsapp: { placeholder: string; hint: string };
        telegram: { placeholder: string; hint: string };
        discord: { placeholder: string; hint: string };
        slack: { placeholder: string; hint: string };
        googlechat: { placeholder: string; hint: string };
      };
      dmPolicyLabel: string;
      dmPolicyAll: string;
      dmPolicyAllowlist: string;
      dmPolicyNone: string;
      dmPolicyHint: string;
      privacySave: string;
      privacySaving: string;
      privacySaved: string;
      privacyError: string;
      pairing: {
        title: string;
        whatsappStep1: string;
        whatsappStep2: string;
        whatsappStep3: string;
        whatsappWarning: string;
        whatsappQrLoading: string;
        whatsappQrInstruction: string;
        whatsappWaiting: string;
        whatsappSuccess: string;
        whatsappTimeout: string;
        whatsappRetry: string;
        whatsappRefreshQr: string;
        telegramStep1: string;
        telegramStep2: string;
        telegramTokenLabel: string;
        telegramTokenPlaceholder: string;
        telegramSubmit: string;
        telegramSubmitting: string;
        telegramHelp: string;
        // Discord (single-token, field=token)
        discordStep1: string;
        discordStep2: string;
        discordTokenLabel: string;
        discordTokenPlaceholder: string;
        discordHelp: string;
        // Generic single-token fallback (untuk channel future yang single-token)
        singleTokenStep1: string;
        singleTokenStep2: string;
        singleTokenLabel: string;
        singleTokenPlaceholder: string;
        singleTokenHelp: string;
        // Slack (3-field socket mode)
        slackStep1: string;
        slackStep2: string;
        slackStep3: string;
        slackBotTokenLabel: string;
        slackBotTokenHelp: string;
        slackBotTokenInvalid: string;
        slackAppTokenLabel: string;
        slackAppTokenHelp: string;
        slackAppTokenInvalid: string;
        slackSigningSecretLabel: string;
        slackSigningSecretHelp: string;
        slackSigningSecretPlaceholder: string;
        // Google Chat
        googlechatInstruction: string;
        googlechatJsonInvalid: string;
        googlechatNotServiceAccount: string;
        googlechatNoProjectId: string;
        googlechatSubscriptionLabel: string;
        googlechatSubscriptionHelp: string;
        googlechatSubscriptionPlaceholder: string;
        googlechatSubscriptionInvalid: string;
        googlechatProjectMismatch: string;
        // Engine restart wait state (after channel config patch)
        restartingTitle: string;
        restartingHelp: string;
        verifyingTitle: string;
        verifyingHelp: string;
        restartingTimeout: string;
        restartingTimeoutHelp: string;
        restartHint: string;
        pollAgain: string;
        refreshPage: string;
        // Success post-restart
        successConnected: string;
        successRoutedTo: string;
        // Agent picker
        agentPickerLabel: string;
        agentPickerLoading: string;
        agentPickerNoAgents: string;
        agentPickerHelp: string;
        // WhatsApp extras
        whatsappPickAgentFirst: string;
        whatsappLinking: string;
        // Shared
        openDocs: string;
        cancel: string;
        close: string;
        success: string;
        genericError: string;
      };
      adapter: {
        whatsappPhone: string;
        whatsappName: string;
        whatsappQrAvailable: string;
        whatsappLinkedSince: string;
        telegramBotPrefix: string;
        telegramMode: string;
        slackTeam: string;
        slackBot: string;
        googlechatAudience: string;
        signalServerHidden: string;
        imessageMacOnly: string;
        nostrPublicKey: string;
        nostrEditProfile: string;
      };
      stateOnline: string;
      stateOffline: string;
      stateConnecting: string;
      stateNeedsSetup: string;
    };
    sessions: {
      eyebrow: string; title: string; subtitle: string; searchPlaceholder: string;
      refresh: string; filterAll: string; filterDirect: string; filterGroup: string; filterGlobal: string;
      sortUpdatedDesc: string; sortUpdatedAsc: string; sortTitle: string; sortKey: string; sortTokens: string;
      totalSessions: string; totalFiltered: string; noneMatchSearch: string;
      open: string; delete: string; deleteConfirm: string;
      columnTitle: string; columnKey: string; columnKind: string; columnTokens: string; columnUpdated: string;
      context: string; tokensUnit: string; neverUpdated: string;
      kindDirect: string; kindGroup: string; kindGlobal: string; kindUnknown: string;
      errorTitle: string;
      /** ── V2 extensions ── */
      /** Inline explainer at top of page. */
      pageExplainer: string;
      emptyTitle: string;
      emptySubtitle: string;
      /** Stats strip labels. */
      statTotal: string;
      statTokens: string;
      statActiveToday: string;
      statLargest: string;
      statRunning: string;
      /** Card chip labels. */
      runningBadge: string;
      compactionBadge: string;
      childBadge: string;
      contextLabel: string;
      /** Inline rename. */
      renamePlaceholder: string;
      renameSave: string;
      renameCancel: string;
      renameSuccess: string;
      renameFailed: string;
      /** Detail drawer tabs. */
      drawerTabSummary: string;
      drawerTabSnapshots: string;
      drawerTabAdvanced: string;
      drawerSectionStats: string;
      drawerSectionModel: string;
      drawerSectionBehavior: string;
      drawerSectionActions: string;
      drawerSectionMeta: string;
      /** Snapshot tab. */
      snapshotsEmpty: string;
      snapshotsExplainer: string;
      snapshotBranch: string;
      snapshotRestore: string;
      snapshotBranchSuccess: string;
      snapshotRestoreSuccess: string;
      snapshotActionFailed: string;
      /** Behavior settings labels. */
      behaviorThinking: string;
      behaviorThinkingHint: string;
      behaviorFastMode: string;
      behaviorFastModeHint: string;
      behaviorVerbose: string;
      behaviorVerboseHint: string;
      behaviorReasoning: string;
      behaviorReasoningHint: string;
      behaviorSave: string;
      behaviorSaveSuccess: string;
      behaviorSaveFailed: string;
      /** Advanced actions. */
      actionReset: string;
      actionResetConfirm: string;
      actionResetSuccess: string;
      actionResetFailed: string;
      actionCompact: string;
      actionCompactHint: string;
      actionCompactSuccess: string;
      actionCompactFailed: string;
      /** Bulk action bar. */
      bulkSelectedCount: string;
      bulkDeleteAll: string;
      bulkClearSelection: string;
      bulkDeleteConfirm: string;
      bulkDeleteSuccess: string;
      bulkDeleteFailed: string;
      /** Status pill labels. */
      statusLive: string;
      statusRunning: string;
      statusAborted: string;
      statusCompleted: string;
      statusError: string;
      statusIdle: string;
      /** Activity tier (last update bucket). */
      activityLive: string;
      activityRecent: string;
      activityToday: string;
      activityOlder: string;
      activityStale: string;
      /** Active minutes filter label. */
      filterActiveMinutes: string;
      filterActiveAny: string;
      filterActive5: string;
      filterActive60: string;
      filterActive1440: string;
      /** Pagination. */
      paginationPageSize: string;
      paginationPageOf: string;
      paginationFirst: string;
      paginationPrev: string;
      paginationNext: string;
      paginationLast: string;
      /** Helpful empty-after-filter state. */
      emptyAfterFilterTitle: string;
      emptyAfterFilterSubtitle: string;
      /** Close drawer button. */
      drawerClose: string;
    };
    shop: {
      demo: {
        subtitle: string;
        toggleMarketplace: string;
        toggleEnergy: string;
        toggleLangganan: string;
        toastPaid: string;
        toastWaitlist: string;
        publicBannerTitle: string;
        publicBannerDesc: string;
        publicBannerCta: string;
        categoryUmkm: string;
        categoryCreator: string;
        categoryProduktivitas: string;
        categoryOperasional: string;
        categoryRiset: string;
        unlockConnector: string;
        unlockSkill: string;
        unlockTool: string;
        unlockPlugin: string;
        unlockApp: string;
        loadCatalogError: string;
        infoStripPrefix: string;
        infoStripAllAgents: string;
        infoStripMiddle: string;
        infoStripFree: string;
        infoStripItemTagged: string;
        infoStripComingSoonTag: string;
        infoStripSuffix: string;
        searchPlaceholder: string;
        sortFeatured: string;
        sortPriceAsc: string;
        sortPriceDesc: string;
        sortName: string;
        catAll: string;
        resultsSuffix: string;
        emptyTitle: string;
        emptySubtitle: string;
        heroComingSoon: string;
        heroFeatured: string;
        heroViewDetail: string;
        heroPrev: string;
        heroNext: string;
        heroSlideLabel: string;
        cardFeatured: string;
        cardComingSoon: string;
        cardViewDetailAria: string;
        ctaWaitlist: string;
        ctaBuyNow: string;
        drawerDialogClose: string;
        drawerCloseAria: string;
        drawerCloseDetailAria: string;
        drawerComingSoon: string;
        drawerOneTime: string;
        drawerAbout: string;
        drawerCapabilities: string;
        drawerComingSoonNotePrefix: string;
        drawerComingSoonNoteBold: string;
        drawerComingSoonNoteSuffix: string;
        drawerPriceLabel: string;
        drawerCtaWaitlist: string;
        drawerCtaBuyPrefix: string;
        energyInfoPrefix: string;
        energyInfoByok: string;
        energyInfoMiddle: string;
        energyInfoEnergy: string;
        energyInfoSuffix: string;
        energyComingSoon: string;
        energyTitle: string;
        energyDescPrefix: string;
        energyDescEnergy: string;
        energyDescSuffix: string;
        energyPerk1Title: string;
        energyPerk1Desc: string;
        energyPerk2Title: string;
        energyPerk2Desc: string;
        energyPerk3Title: string;
        energyPerk3Desc: string;
        energyPerk4Title: string;
        energyPerk4Desc: string;
      };
    };
    riwayat: {
      title: string;
      subtitle: string;
      loading: string;
      error: string;
      retry: string;
      empty: string;
      emptyFiltered: string;
      downloadStruk: string;
      checkStatus: string;
      checking: string;
      pendingHint: string;
      summarySpent: string;
      summaryCount: string;
      filters: {
        all: string;
        last7d: string;
        last30d: string;
        last90d: string;
        allCategories: string;
        allStatuses: string;
        statusSuccess: string;
        statusPending: string;
        statusFailed: string;
        searchPlaceholder: string;
        dateFrom: string;
        dateTo: string;
        resetDates: string;
        reset: string;
        more: string;
      };
      status: {
        completed: string;
        pending: string;
        failed: string;
        refunded: string;
        installIssue: string;
      };
      type: {
        subscription: string;
        topup: string;
        skill: string;
      };
      statusCard: {
        statusActive: string;
        statusTrial: string;
        statusNone: string;
        statusExpired: string;
        statusCanceled: string;
        activeUntil: string;
        trialRemainingPrefix: string;
        trialDaysSuffix: string;
        cycleMonthly: string;
        cycleYearly: string;
        noneHint: string;
        expiredHint: string;
      };
    };
    usage: {
      eyebrow: string; title: string; subtitle: string;
      tokensToday: string; costToday: string;
      refresh: string; period: string; periodDays: string;
      summaryCost: string; summaryTokens: string; summarySessions: string; summaryProviders: string; costIncludedNote: string;
      chartTokens: string; chartCost: string; chartEmpty: string;
      providersHeader: string; providersEmpty: string;
      windowUsed: string; windowResetsIn: string;
      topSessionsHeader: string; topSessionsEmpty: string;
      colSession: string; colModel: string; colMessages: string; colTokens: string; colCost: string;
      periodChoice7: string; periodChoice14: string; periodChoice30: string;
      viewTokens: string; viewCost: string;
      cacheReadLabel: string; cacheWriteLabel: string; inputLabel: string; outputLabel: string;
      compositionTitle: string; cacheHitLabel: string; cacheHitNote: string;
      avgPerSession: string; avgPerSessionNote: string;
      messagesLabel: string; sessionsLabel: string;
      billingSubscriptionLabel: string; billingSubscriptionNote: string;
      billingPaidNote: string; billingUnknownLabel: string; billingUnknownNote: string;
      channelLabel: string; periodNote: string;
    };
    cron: {
      eyebrow: string; title: string; subtitle: string;
      newJob: string; fireNow: string; enabled: string; disabled: string;
      refresh: string; empty: string; emptyHint: string;
      colName: string; colSchedule: string; colNextRun: string; colLastRun: string; colStatus: string; colActions: string;
      statusOk: string; statusError: string; statusSkipped: string; statusPending: string; statusRunning: string;
      toggleEnable: string; toggleDisable: string;
      firingNow: string; fireSuccess: string; fireFailed: string; fireEnqueued: string;
      fireNotDue: string; fireAlreadyRunning: string; fireInvalidSpec: string;
      historyHeader: string; historyFor: string; historyEmpty: string; historyColTime: string; historyColStatus: string; historyColDuration: string; historyColSummary: string;
      historyClose: string;
      deleteConfirm: string; deleteConfirmHint: string; deleting: string;
      scheduleAtPrefix: string; scheduleEveryPrefix: string; scheduleCronPrefix: string;
      payloadAgentTurn: string; payloadSystemEvent: string;
      nextRunSoon: string; neverRan: string;
      summaryTotal: string; summaryEnabled: string; summaryRunning: string;
      toastFired: string; toastCompleted: string; toastErrored: string;
    };
    agents: {
      eyebrow: string; title: string; subtitle: string;
      newAgent: string; refresh: string;
      empty: string; emptyHint: string;
      defaultBadge: string; mainBadge: string;
      scopePerSender: string; scopeGlobal: string;
      colName: string; colModel: string; colWorkspace: string; colStatus: string; colActions: string;
      edit: string; remove: string; removing: string; removeConfirm: string;
      removeConfirmHint: string;
      detailHeader: string; detailClose: string;
      fieldId: string; fieldName: string; fieldWorkspace: string; fieldModel: string;
      fieldModelPrimary: string; fieldModelFallbacks: string; fieldEmoji: string; fieldAvatar: string;
      fieldNamePlaceholder: string; fieldWorkspacePlaceholder: string; fieldModelPlaceholder: string;
      filesTabName: string;
      filesLoading: string; filesEmpty: string;
      filesMissing: string; filesExists: string;
      fileSave: string; fileSaving: string; fileSaved: string; fileSaveFailed: string;
      fileUnsaved: string; fileLoad: string; fileLoading: string;
      fileReset: string;
      sizeLabel: string; updatedLabel: string;
      createHeader: string; createSubmit: string; creating: string; createCancel: string;
      createSuccess: string; createFailed: string;
      updateHeader: string; updateSubmit: string; updating: string;
      updateSuccess: string; updateFailed: string;
      removeSuccess: string; removeFailed: string;
      deleteFilesOption: string; deleteFilesHint: string;
      summaryTotal: string; summaryDefault: string; summaryScope: string;
      modelFallbacksHint: string;
      fileDescAgentsJson: string; fileDescSoulMd: string; fileDescToolsJson: string;
      fileDescIdentityMd: string; fileDescUserJson: string; fileDescHeartbeatJson: string;
      fileDescBootstrap: string; fileDescMemoryJson: string; fileDescOther: string;
    };
  };
}
