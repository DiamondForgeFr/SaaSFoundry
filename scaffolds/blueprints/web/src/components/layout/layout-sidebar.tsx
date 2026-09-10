/**
 * Dependencies
 */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Components
 */
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarSeparator, useSidebar } from '@/components/ui/shadcn/sidebar'

import { NavSection } from '@/components/nav/nav-section'
import { NavUser } from '@/components/nav/nav-user'
import { useAdminScope } from '@/hooks/auth/useAdminScope'

/**
 * Icons
 */
import { Car, ChartNoAxesCombined, ClipboardList, ContactRound, HandCoins, Handshake, Package, ShoppingBag, Users } from 'lucide-react'

/**
 * TS Types
 */
import type { NavSectionItem } from '@/components/nav/nav-section'
import type { ComponentProps } from 'react'

import { Logo } from '@/components/ui/custom/logo'

type NavigationItem = {
  title: string
  items: NavSectionItem[]
}

type SideBarConfig = {
  navigation: NavigationItem[]
}

/**
 * Config
 */
const data: SideBarConfig = {
  navigation: [
    {
      title: 'main-navigation.tk_menu-group_',
      items: [
        {
          title: 'main-navigation.tk_summary_',
          url: '#',
          icon: ClipboardList,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-1_',
          url: '#',
          icon: Package,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-2_',
          url: '#',
          icon: Handshake,
          isActive: true
        }
      ]
    },
    {
      title: 'main-navigation.tk_menu-group_',
      items: [
        {
          title: 'main-navigation.tk_summary_',
          url: '#',
          icon: ClipboardList,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-1_',
          url: '#',
          icon: Users,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-2_',
          url: '#',
          icon: ContactRound,
          isActive: true
        }
      ]
    },
    {
      title: 'main-navigation.tk_menu-group_',
      items: [
        {
          title: 'main-navigation.tk_feature-1_',
          url: '#',
          icon: ShoppingBag,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-2_',
          url: '#',
          icon: HandCoins,
          isActive: true
        },
        {
          title: 'main-navigation.tk_feature-3_',
          url: '#',
          icon: Car,
          isActive: true,
          subItems: [
            {
              title: 'main-navigation.tk_sub-feature-1_',
              url: '#'
            },
            {
              title: 'main-navigation.tk_sub-feature-2_',
              url: '#'
            },
            {
              title: 'main-navigation.tk_sub-feature-3_',
              url: '#'
            }
          ]
        }
      ]
    }
  ]
}

/**
 * React declaration
 */
export const LayoutSidebar = ({ ...props }: ComponentProps<typeof Sidebar>) => {
  const { state } = useSidebar()
  const { t: tNav } = useTranslation('nav')
  const isCollapsed = state === 'collapsed'
  const navigate = useNavigate()
  const location = useLocation()
  const isDashboardActive = location.pathname.startsWith('/dashboard')
  // When the user has access only to disabled accounts, the sidebar collapses to a no-op:
  // every feature link would 302 to /account/reactivation anyway, and showing them creates
  // false hope. Platform-admins keep the full sidebar.
  const { isPlatformAdmin, allAccounts } = useAdminScope()
  const isAccountDisabledMode = !isPlatformAdmin && allAccounts.length > 0 && allAccounts.every((a) => !a.isActive)

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <Logo
          className={!isCollapsed ? 'cursor-pointer px-3 pt-3 pb-1 [&>img]:h-12 [&>img]:w-auto [&>img]:max-w-full [&>img]:object-contain' : 'cursor-pointer [&>img]:h-8 [&>img]:w-auto'}
          isLong={!isCollapsed}
          onClick={() => navigate('/dashboard')}
        />
      </SidebarHeader>
      <SidebarContent>
        {!isAccountDisabledMode && (
          <>
            <SidebarMenu className="mt-6 px-1">
              <SidebarMenuItem className="relative">
                {isDashboardActive && <span aria-hidden className="pointer-events-none absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r bg-primary" />}
                <SidebarMenuButton
                  isActive={isDashboardActive}
                  tooltip={tNav('main-navigation.tk_dashboard_')}
                  onClick={() => navigate('/dashboard')}
                  className="data-[active=true]:bg-sidebar-accent/70 data-[active=true]:font-semibold data-[active=true]:[&>svg]:text-primary"
                >
                  <ChartNoAxesCombined />
                  <span>{tNav('main-navigation.tk_dashboard_')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            {data.navigation.map((section, index) => (
              <Fragment key={`nav-section-${index}`}>
                <SidebarSeparator className="bg-sidebar-border/50 mx-2 my-1" />
                <NavSection section={section} />
              </Fragment>
            ))}
          </>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
