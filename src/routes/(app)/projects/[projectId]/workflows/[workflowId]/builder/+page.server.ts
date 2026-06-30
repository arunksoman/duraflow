import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	return {
		projectId: params.projectId,
		workflowId: params.workflowId,
		projectName: params.projectId === 'demo' ? 'Demo Project' : 'Project',
		workflowName: params.workflowId === 'demo' ? 'Order Fulfillment' : 'New Workflow'
	};
};
