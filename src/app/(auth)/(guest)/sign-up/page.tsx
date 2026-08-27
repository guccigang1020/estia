import type { Metadata } from 'next'

import { AuthCard, AuthLink } from '@/components/auth/auth-card'

import { SignUpForm } from './sign-up-form'

export const metadata: Metadata = { title: 'הרשמה' }

/** EXECUTION CONTEXT — SERVER COMPONENT. */
export default function SignUpPage() {
  return (
    <AuthCard
      title="יצירת חשבון"
      description="חשבון אישי אחד, לכל הארגונים שאתם חברים בהם."
      footer={
        <span>
          כבר יש לכם חשבון? <AuthLink href="/sign-in">כניסה</AuthLink>
        </span>
      }
    >
      <SignUpForm />
    </AuthCard>
  )
}
